import express from 'express'; import { fileURLToPath } from 'url'; import helmet from 'helmet'; import cors from 'cors'; import rateLimit from 'express-rate-limit';
import multer from 'multer'; import fs from 'fs'; import ExcelJS from 'exceljs'; import cron from 'node-cron'; import { z } from 'zod'; import 'dotenv/config';
import { q, audit } from './db.js'; import { auth, login } from './auth.js'; import { importPunches, parseCsv, processDay } from './attendance.js'; import { runPayroll } from './payroll.js'; import { extra } from './extra.js'; import { modules } from './modules.js';
const app = express(); app.use(helmet({ contentSecurityPolicy: false }), cors(), express.json()); app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const up = multer({ dest: 'uploads/', limits: { fileSize: 5e6 } });
app.use('/api/login', rateLimit({ windowMs: 6e5, max: +(process.env.LOGIN_RATE_MAX || 20) }));
const wrap = f => (req, res) => f(req, res).catch(e => res.status(400).json({ error: e.message }));
const locked = async day => (await q(`SELECT 1 FROM periods WHERE ym=$1 AND status<>'open'`, [String(day).slice(0, 7)])).length > 0;
const iso = d => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const token = await login(email, password); if (!token) return res.status(401).json({ error: 'invalid credentials' }); res.json({ token });
}));
app.post('/api/punches/import', auth('hr', 'it_admin', 'super_admin'), up.single('file'), wrap(async (req, res) => {
  const r = await importPunches(parseCsv(fs.readFileSync(req.file.path))); await audit(req.user.id, 'punch_import', 'punches', '-', r); res.json(r);
}));
app.post('/api/attendance/process', auth('hr', 'it_admin', 'super_admin'), wrap(async (req, res) => {
  const { day } = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.body);
  if (await locked(day)) throw new Error('Period locked');
  for (const u of await q(`SELECT id FROM users WHERE active AND device_user_id IS NOT NULL`)) await processDay(u.id, day);
  const [n] = await q(`SELECT count(*) FROM daily_attendance WHERE day=$1 AND anomaly IS NOT NULL`, [day]);
  if (+n.count) await q(`INSERT INTO notifications(user_id,message) SELECT id,$1 FROM users WHERE role='hr' AND active`, [`${n.count} attendance exception(s) on ${day} need review`]);
  res.json({ ok: true, exceptions: +n.count });
}));
app.get('/api/attendance/anomalies', auth('hr', 'manager', 'super_admin'), wrap(async (_r, res) =>
  res.json(await q(`SELECT d.*, u.full_name FROM daily_attendance d JOIN users u ON u.id=d.user_id WHERE anomaly IS NOT NULL ORDER BY day DESC LIMIT 200`))));
app.get('/api/me/attendance', auth(), wrap(async (req, res) => res.json(await q('SELECT * FROM daily_attendance WHERE user_id=$1 ORDER BY day DESC LIMIT 62', [req.user.id]))));

// Corrections: employee -> manager -> HR
app.post('/api/corrections', auth(), up.single('attachment'), wrap(async (req, res) => {
  const b = z.object({ day: z.string(), new_in: z.string().optional(), new_out: z.string().optional(), reason: z.string().min(10), type: z.enum(['correction', 'regularization']).default('correction') }).parse(req.body);
  if (await locked(b.day)) throw new Error('Period locked');
  const [c] = await q('INSERT INTO corrections(user_id,day,new_in,new_out,reason,attachment_path,type) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [req.user.id, b.day, b.new_in || null, b.new_out || null, b.reason, req.file?.path, b.type]);
  const [m] = await q('SELECT manager_id FROM users WHERE id=$1', [req.user.id]);
  if (m?.manager_id) await q('INSERT INTO notifications(user_id,message) VALUES($1,$2)', [m.manager_id, `Correction #${c.id} awaiting your approval`]);
  await audit(req.user.id, 'correction_submit', 'corrections', c.id, b); res.json(c);
}));
app.post('/api/corrections/:id/decide', auth('manager', 'hr', 'super_admin'), wrap(async (req, res) => {
  const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
  const [c] = await q('SELECT * FROM corrections WHERE id=$1', [req.params.id]);
  const stage = req.user.role === 'manager' ? 'pending_manager' : 'pending_hr';
  if (c.status !== stage) throw new Error(`Not awaiting ${req.user.role}`);
  if (req.user.role === 'manager' && !(await q('SELECT 1 FROM users WHERE id=$1 AND manager_id=$2', [c.user_id, req.user.id])).length) throw new Error('Not your report');
  if (await locked(iso(c.day))) throw new Error('Period locked');
  const next = !approve ? 'rejected' : stage === 'pending_manager' ? 'pending_hr' : 'approved';
  await q('UPDATE corrections SET status=$1 WHERE id=$2', [next, c.id]);
  await q('INSERT INTO notifications(user_id,message) VALUES($1,$2)', [c.user_id, `Your correction request #${c.id} is now ${next}`]);
  if (next === 'pending_hr') await q(`INSERT INTO notifications(user_id,message) SELECT id,$1 FROM users WHERE role='hr' AND active`, [`Correction #${c.id} awaiting HR approval`]);
  let orig = null;
  if (next === 'approved') {
    [orig] = await q('SELECT * FROM daily_attendance WHERE user_id=$1 AND day=$2', [c.user_id, iso(c.day)]);
    for (const t of [c.new_in, c.new_out].filter(Boolean)) await q(`INSERT INTO punches(user_id,punched_at,source) VALUES($1,$2,'correction') ON CONFLICT DO NOTHING`, [c.user_id, t]);
    await processDay(c.user_id, iso(c.day));
  }
  await audit(req.user.id, approve ? 'correction_approve' : 'correction_reject', 'corrections', c.id, { next, original: orig ?? null, comment: req.body.comment ?? null }); res.json({ status: next });
}));

// Period close / lock / reopen
app.post('/api/periods/:ym/close', auth('hr', 'super_admin'), wrap(async (req, res) => {
  const [o] = await q(`SELECT (SELECT count(*) FROM corrections WHERE status LIKE 'pending%' AND to_char(day,'YYYY-MM')=$1) + (SELECT count(*) FROM leaves WHERE status LIKE 'pending%' AND to_char(from_date,'YYYY-MM')=$1) + (SELECT count(*) FROM overtime_requests WHERE status LIKE 'pending%' AND to_char(day,'YYYY-MM')=$1) AS count`, [req.params.ym]);
  if (+o.count) throw new Error(`${o.count} pending approval(s) remain for this month`);
  const st = req.user.role === 'super_admin' ? 'locked' : 'pending_authorization';
  await q(`INSERT INTO periods(ym,status,closed_by,closed_at) VALUES($1,$3,$2,now()) ON CONFLICT(ym) DO UPDATE SET status=$3,closed_by=$2,closed_at=now()`, [req.params.ym, req.user.id, st]);
  await q(`INSERT INTO notifications(user_id,message) SELECT id,$1 FROM users WHERE active AND ($2='locked' OR role='super_admin')`, [`Attendance ${req.params.ym}: ${st === 'locked' ? 'closed and locked' : 'awaiting management authorization'}`, st]);
  await audit(req.user.id, 'period_close', 'periods', req.params.ym, { status: st }); res.json({ ok: true });
}));
app.post('/api/periods/:ym/reopen', auth('super_admin'), wrap(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(10) }).parse(req.body);
  await q(`UPDATE periods SET status='open' WHERE ym=$1`, [req.params.ym]); await audit(req.user.id, 'period_reopen', 'periods', req.params.ym, { reason }); res.json({ ok: true });
}));

// Payroll + exports
app.post('/api/payroll/:ym/run', auth('payroll_officer', 'super_admin'), wrap(async (req, res) => { await runPayroll(req.params.ym); await audit(req.user.id, 'payroll_run', 'payroll', req.params.ym); res.json({ ok: true }); }));
app.get('/api/audit', auth('super_admin', 'it_admin'), wrap(async (_r, res) => res.json(await q('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500'))));
app.get('/api/notifications', auth(), wrap(async (req, res) => res.json(await q('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.user.id]))));

cron.schedule('0 9 * * *', async () => {
  for (const c of await q(`SELECT c.id, u.manager_id FROM corrections c JOIN users u ON u.id=c.user_id WHERE c.status='pending_manager' AND c.created_at < now() - interval '2 days'`))
    await q('INSERT INTO notifications(user_id,message) VALUES($1,$2)', [c.manager_id, `Reminder: correction #${c.id} pending`]);
});
extra(app, { wrap, locked, up }); modules(app, { wrap, locked, up });
app.listen(process.env.PORT || 4000, () => console.log('API up'));
