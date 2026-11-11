import path from 'path'; import { z } from 'zod'; import PDFDocument from 'pdfkit'; import ExcelJS from 'exceljs'; import cron from 'node-cron';
import { q, audit } from './db.js'; import { auth, hash, verifyPw } from './auth.js';
const ymOk = ym => { if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('Bad month (YYYY-MM)'); return ym; };
const scopeSql = r => r === 'employee' ? 't.user_id=$1' : r === 'manager' ? 'u.manager_id=$1' : '$1::int IS NOT NULL';
const redact = o => ('base_salary' in o ? { ...o, base_salary: '[redacted]' } : o);
const PENDING = `(SELECT count(*) FROM corrections WHERE status LIKE 'pending%' AND to_char(day,'YYYY-MM')=$1) + (SELECT count(*) FROM leaves WHERE status LIKE 'pending%' AND to_char(from_date,'YYYY-MM')=$1) + (SELECT count(*) FROM overtime_requests WHERE status LIKE 'pending%' AND to_char(day,'YYYY-MM')=$1)`;
const monthly = (ym, role, uid) => q(`SELECT u.id, u.full_name, d.name dept,
  count(*) FILTER (WHERE a.status='present') present, count(*) FILTER (WHERE a.status IN ('absent','incomplete')) absent, count(*) FILTER (WHERE a.status='leave') leave,
  coalesce(sum(a.late_min),0) late_min, coalesce(sum(a.early_min),0) early_min, coalesce(sum(a.overtime_min),0) ot_min, count(*) FILTER (WHERE a.anomaly IS NOT NULL) exceptions
  FROM users u LEFT JOIN departments d ON d.id=u.dept_id LEFT JOIN daily_attendance a ON a.user_id=u.id AND to_char(a.day,'YYYY-MM')=$1
  WHERE u.role<>'it_admin' AND u.active AND u.device_user_id IS NOT NULL AND ($2<>'manager' OR u.manager_id=$3) GROUP BY u.id, d.name ORDER BY u.id`, [ym, role, uid]);
function pdfTable(res, title, sub, cols, rows) {
  res.type('application/pdf'); const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' }); doc.pipe(res);
  doc.fontSize(16).text(title).fontSize(9).fillColor('#555').text(sub).moveDown(); doc.fillColor('#000');
  const w = (doc.page.width - 72) / cols.length; let y = doc.y;
  const row = (v, b) => { if (y > doc.page.height - 60) { doc.addPage(); y = 36; } doc.font(b ? 'Helvetica-Bold' : 'Helvetica').fontSize(8); v.forEach((x, i) => doc.text(String(x ?? ''), 36 + i * w, y, { width: w - 4, height: 11, ellipsis: true })); y += 14; };
  row(cols.map(c => c[0]), true); rows.forEach(r => row(cols.map(c => c[1](r)))); doc.end();
}
async function sendXlsx(res, name, cols, rows) {
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(name); ws.columns = cols.map(c => ({ header: c, key: c, width: 18 })); ws.addRows(rows);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename=${name}.xlsx`); await wb.xlsx.write(res); res.end();
}
export function modules(app, { wrap, locked, up }) {
  const MGMT = ['hr', 'super_admin', 'manager', 'payroll_officer'];
  // ---- setup data
  app.get('/api/meta', auth(), wrap(async (_r, res) => res.json({ departments: await q('SELECT * FROM departments ORDER BY name'), designations: await q('SELECT * FROM designations ORDER BY name'),
    holidays: await q('SELECT * FROM holidays ORDER BY day'), weekly_off: (await q(`SELECT value FROM settings WHERE key='weekly_off'`))[0].value })));
  for (const [p, t] of [['departments', 'departments'], ['designations', 'designations']])
    app.post('/api/' + p, auth('hr', 'super_admin'), wrap(async (req, res) => { const { name } = z.object({ name: z.string().min(2).max(80) }).parse(req.body);
      const [r] = await q(`INSERT INTO ${t}(name) VALUES($1) RETURNING *`, [name]); await audit(req.user.id, 'create', t, r.id, { name }); res.json(r); }));
  app.post('/api/holidays', auth('hr', 'super_admin'), wrap(async (req, res) => { const b = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().min(2) }).parse(req.body);
    await q('INSERT INTO holidays(day,name) VALUES($1,$2) ON CONFLICT(day) DO UPDATE SET name=$2', [b.day, b.name]); await audit(req.user.id, 'holiday_set', 'holidays', b.day, b); res.json({ ok: true }); }));
  app.delete('/api/holidays/:day', auth('hr', 'super_admin'), wrap(async (req, res) => { await q('DELETE FROM holidays WHERE day=$1', [req.params.day]); await audit(req.user.id, 'holiday_delete', 'holidays', req.params.day); res.json({ ok: true }); }));
  app.put('/api/settings/weekly_off', auth('hr', 'super_admin'), wrap(async (req, res) => { const { value } = z.object({ value: z.string().regex(/^[0-6](,[0-6])*$/) }).parse(req.body);
    await q(`UPDATE settings SET value=$1 WHERE key='weekly_off'`, [value]); await audit(req.user.id, 'weekly_off_set', 'settings', 'weekly_off', { value }); res.json({ ok: true }); }));
  // ---- employee profiles (field-level permissions per role)
  const PROFILE = ['full_name', 'dept_id', 'designation_id', 'manager_id', 'device_user_id', 'status', 'join_date', 'active'], STAFF = ['employee', 'manager'];
  const FIELDS = { super_admin: [...PROFILE, 'role', 'base_salary'], hr: PROFILE, payroll_officer: ['base_salary'] };
  app.post('/api/users', auth('hr', 'super_admin'), wrap(async (req, res) => {
    const b = z.object({ email: z.string().email(), full_name: z.string().min(2), password: z.string().min(10), role: z.enum(['super_admin', 'hr', 'manager', 'employee', 'payroll_officer', 'it_admin']).default('employee'),
      dept_id: z.number().optional(), designation_id: z.number().optional(), manager_id: z.number().optional(), device_user_id: z.string().optional(), join_date: z.string().optional(), base_salary: z.number().min(0).optional() }).parse(req.body);
    if (req.user.role !== 'super_admin' && !STAFF.includes(b.role)) throw new Error('Only Super Admin can create this role');
    const [u] = await q(`INSERT INTO users(email,password_hash,role,full_name,dept_id,designation_id,manager_id,device_user_id,join_date,base_salary) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,email,role,full_name`,
      [b.email, await hash(b.password), b.role, b.full_name, b.dept_id ?? null, b.designation_id ?? null, b.manager_id ?? null, b.device_user_id ?? null, b.join_date ?? null, req.user.role === 'super_admin' ? b.base_salary ?? 0 : 0]);
    await audit(req.user.id, 'user_create', 'users', u.id, { email: b.email, role: b.role }); res.json(u);
  }));
  app.patch('/api/users/:id', auth('hr', 'super_admin', 'payroll_officer'), wrap(async (req, res) => {
    const allowed = FIELDS[req.user.role], patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k))), keys = Object.keys(patch);
    if (!keys.length) throw new Error('Nothing to update');
    if (patch.status && !['active', 'probation', 'on_leave', 'terminated'].includes(patch.status)) throw new Error('Invalid status');
    const [before] = await q('SELECT * FROM users WHERE id=$1', [req.params.id]); if (!before) throw new Error('Not found');
    if (req.user.role === 'hr' && !STAFF.includes(before.role)) throw new Error('Not permitted for this user');
    const kill = patch.status === 'terminated' || patch.active === false;
    await q(`UPDATE users SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')}${kill ? ',token_version=token_version+1' : ''} WHERE id=$1`, [req.params.id, ...keys.map(k => patch[k])]);
    await audit(req.user.id, 'user_update', 'users', req.params.id, { before: redact(Object.fromEntries(keys.map(k => [k, before[k]]))), after: redact(patch) }); res.json({ ok: true });
  }));
  app.post('/api/me/password', auth(), wrap(async (req, res) => {
    const b = z.object({ old: z.string(), new: z.string().min(10) }).parse(req.body); const [u] = await q('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!(await verifyPw(b.old, u.password_hash))) throw new Error('Current password is wrong');
    await q('UPDATE users SET password_hash=$1, token_version=token_version+1 WHERE id=$2', [await hash(b.new), req.user.id]); await audit(req.user.id, 'password_change', 'users', req.user.id); res.json({ ok: true });
  }));
  app.post('/api/me/logout-all', auth(), wrap(async (req, res) => { await q('UPDATE users SET token_version=token_version+1 WHERE id=$1', [req.user.id]); res.json({ ok: true }); }));
  // ---- leaves & overtime (employee -> manager -> HR)
  const notifyMgr = (uid, msg) => q('INSERT INTO notifications(user_id,message) SELECT manager_id,$2 FROM users WHERE id=$1 AND manager_id IS NOT NULL', [uid, msg]);
  app.post('/api/leaves', auth(), up.single('attachment'), wrap(async (req, res) => {
    const b = z.object({ from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), paid: z.string().optional(), reason: z.string().optional() }).parse(req.body);
    if (b.to_date < b.from_date) throw new Error('Invalid date range'); if (await locked(b.from_date)) throw new Error('Period locked');
    const [l] = await q('INSERT INTO leaves(user_id,from_date,to_date,paid,reason,attachment_path) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [req.user.id, b.from_date, b.to_date, b.paid !== 'false', b.reason ?? null, req.file?.path ?? null]);
    await notifyMgr(req.user.id, `Leave request #${l.id} awaiting your approval`); await audit(req.user.id, 'leave_submit', 'leaves', l.id, b); res.json(l);
  }));
  app.get('/api/overtime', auth(), wrap(async (req, res) => res.json(await q(`SELECT t.*, u.full_name FROM overtime_requests t JOIN users u ON u.id=t.user_id WHERE ${scopeSql(req.user.role)} ORDER BY t.id DESC LIMIT 100`, [req.user.id]))));
  app.post('/api/overtime', auth(), up.single('attachment'), wrap(async (req, res) => {
    const b = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), minutes: z.coerce.number().int().min(15).max(720), reason: z.string().min(10) }).parse(req.body);
    if (await locked(b.day)) throw new Error('Period locked');
    const [o] = await q('INSERT INTO overtime_requests(user_id,day,minutes,reason,attachment_path) VALUES($1,$2,$3,$4,$5) RETURNING *', [req.user.id, b.day, b.minutes, b.reason, req.file?.path ?? null]);
    await notifyMgr(req.user.id, `Overtime request #${o.id} awaiting your approval`); await audit(req.user.id, 'overtime_submit', 'overtime_requests', o.id, b); res.json(o);
  }));
  const decide = (table, dateCol) => wrap(async (req, res) => {
    const { approve, comment } = z.object({ approve: z.boolean(), comment: z.string().max(500).optional() }).parse(req.body);
    const [r] = await q(`SELECT * FROM ${table} WHERE id=$1`, [req.params.id]); if (!r) throw new Error('Not found');
    const stage = req.user.role === 'manager' ? 'pending_manager' : 'pending_hr';
    if (r.status !== stage) throw new Error(`Not awaiting ${req.user.role}`);
    if (req.user.role === 'manager' && !(await q('SELECT 1 FROM users WHERE id=$1 AND manager_id=$2', [r.user_id, req.user.id])).length) throw new Error('Not your report');
    if (await locked(r[dateCol])) throw new Error('Period locked');
    const next = !approve ? 'rejected' : stage === 'pending_manager' ? 'pending_hr' : 'approved';
    await q(`UPDATE ${table} SET status=$1 WHERE id=$2`, [next, r.id]);
    await q('INSERT INTO notifications(user_id,message) VALUES($1,$2)', [r.user_id, `Your ${table.replace('_requests', '')} request #${r.id} is now ${next}`]);
    if (next === 'pending_hr') await q(`INSERT INTO notifications(user_id,message) SELECT id,$1 FROM users WHERE role='hr' AND active`, [`${table} #${r.id} awaiting HR approval`]);
    await audit(req.user.id, `${table}_${approve ? 'approve' : 'reject'}`, table, r.id, { from: r.status, next, comment: comment ?? null }); res.json({ status: next });
  });
  app.post('/api/leaves/:id/decide', auth('manager', 'hr', 'super_admin'), decide('leaves', 'from_date'));
  app.post('/api/overtime/:id/decide', auth('manager', 'hr', 'super_admin'), decide('overtime_requests', 'day'));
  app.get('/api/tasks', auth(), wrap(async (req, res) => {
    const r = req.user.role, stage = r === 'manager' ? 'pending_manager' : ['hr', 'super_admin'].includes(r) ? 'pending_hr' : null;
    const cnt = async t => stage ? +(await q(`SELECT count(*) FROM ${t} t JOIN users u ON u.id=t.user_id WHERE t.status=$1 AND ($2<>'manager' OR u.manager_id=$3)`, [stage, r, req.user.id]))[0].count : 0;
    res.json({ corrections: await cnt('corrections'), leaves: await cnt('leaves'), overtime: await cnt('overtime_requests'), authorizations: r === 'super_admin' ? +(await q(`SELECT count(*) FROM periods WHERE status='pending_authorization'`))[0].count : 0 });
  }));
  app.get('/api/attachment/:table/:id', auth(), wrap(async (req, res) => {
    const t = ['corrections', 'leaves', 'overtime_requests'].find(x => x === req.params.table); if (!t) throw new Error('Bad type');
    const [r] = await q(`SELECT t.attachment_path, t.user_id, u.manager_id FROM ${t} t JOIN users u ON u.id=t.user_id WHERE t.id=$1`, [req.params.id]);
    if (!r?.attachment_path) throw new Error('No attachment');
    if (!(r.user_id === req.user.id || r.manager_id === req.user.id || ['hr', 'super_admin'].includes(req.user.role))) return res.status(403).json({ error: 'forbidden' });
    await audit(req.user.id, 'attachment_view', t, req.params.id); res.download(path.resolve(r.attachment_path));
  }));
  // ---- month authorization (management sign-off)
  app.post('/api/periods/:ym/authorize', auth('super_admin'), wrap(async (req, res) => {
    const ym = ymOk(req.params.ym), { comment } = z.object({ comment: z.string().max(500).optional() }).parse(req.body);
    const [p] = await q('SELECT status FROM periods WHERE ym=$1', [ym]); if (p?.status !== 'pending_authorization') throw new Error('Month is not awaiting authorization');
    await q(`UPDATE periods SET status='locked', authorized_by=$2, authorized_at=now() WHERE ym=$1`, [ym, req.user.id]);
    await q(`INSERT INTO notifications(user_id,message) SELECT id,$1 FROM users WHERE active`, [`Attendance for ${ym} is authorized and locked`]);
    await audit(req.user.id, 'period_authorize', 'periods', ym, { comment: comment ?? null }); res.json({ ok: true });
  }));
  // ---- analytics & reports
  app.get('/api/analytics', auth(...MGMT), wrap(async (req, res) => {
    const ym = ymOk(String(req.query.ym || new Date().toLocaleDateString('en-CA').slice(0, 7))), rows = await monthly(ym, req.user.role, req.user.id), sum = k => rows.reduce((s, r) => s + Number(r[k]), 0);
    const present = sum('present'), absent = sum('absent'), tot = Math.max(1, present + absent), dep = {};
    for (const r of rows) { const d = (dep[r.dept || 'Unassigned'] ??= { dept: r.dept || 'Unassigned', staff: 0, present: 0, absent: 0, late_min: 0, ot_min: 0, exceptions: 0 });
      d.staff++; for (const k of ['present', 'absent', 'late_min', 'ot_min', 'exceptions']) d[k] += Number(r[k]); }
    const daily = await q(`SELECT a.day, count(*) FILTER (WHERE a.status='present') present, count(*) FILTER (WHERE a.status IN ('absent','incomplete')) absent FROM daily_attendance a JOIN users u ON u.id=a.user_id
      WHERE to_char(a.day,'YYYY-MM')=$1 AND ($2<>'manager' OR u.manager_id=$3) GROUP BY a.day ORDER BY a.day`, [ym, req.user.role, req.user.id]);
    const [p] = await q('SELECT status FROM periods WHERE ym=$1', [ym]), [pe] = await q(`SELECT ${PENDING} n`, [ym]);
    res.json({ ym, kpi: { staff: rows.length, attendanceRate: +(present / tot * 100).toFixed(1), absenteeism: +(absent / tot * 100).toFixed(1), overtimeHours: +(sum('ot_min') / 60).toFixed(1), exceptions: sum('exceptions'), pendingApprovals: +pe.n, closure: p?.status || 'open' }, departments: Object.values(dep), daily });
  }));
  const MCOLS = [['Employee', r => r.full_name], ['Department', r => r.dept], ['Present', r => r.present], ['Absent', r => r.absent], ['Leave', r => r.leave], ['Late min', r => r.late_min], ['Early min', r => r.early_min], ['OT min', r => r.ot_min], ['Exceptions', r => r.exceptions]];
  app.get('/api/reports/monthly/:ym/attendance.pdf', auth(...MGMT), wrap(async (req, res) => {
    const ym = ymOk(req.params.ym), rows = await monthly(ym, req.user.role, req.user.id), [p] = await q(`SELECT p.status, p.authorized_at, u.full_name FROM periods p LEFT JOIN users u ON u.id=p.authorized_by WHERE p.ym=$1`, [ym]), [pe] = await q(`SELECT ${PENDING} n`, [ym]);
    pdfTable(res, `Monthly attendance summary ${ym}`, `Status: ${p?.status || 'open'}${p?.authorized_at ? ` | Authorized by ${p.full_name} on ${new Date(p.authorized_at).toISOString().slice(0, 16).replace('T', ' ')}` : ''} | Pending approvals: ${pe.n}`, MCOLS, rows);
  }));
  app.get('/api/reports/monthly/:ym/attendance.xlsx', auth(...MGMT), wrap(async (req, res) => { const rows = await monthly(ymOk(req.params.ym), req.user.role, req.user.id);
    await sendXlsx(res, `attendance_${req.params.ym}`, MCOLS.map(c => c[0]), rows.map(r => Object.fromEntries(MCOLS.map(c => [c[0], c[1](r)])))); }));
  const payRows = ym => q(`SELECT u.full_name, u.email, r.payable_days, r.unpaid_days, r.ot_minutes, r.allowances, r.deductions, r.net FROM payroll_runs r JOIN users u ON u.id=r.user_id WHERE r.ym=$1 ORDER BY u.id`, [ym]);
  const PCOLS = ['full_name', 'email', 'payable_days', 'unpaid_days', 'ot_minutes', 'allowances', 'deductions', 'net'];
  app.get('/api/payroll/:ym/export.xlsx', auth('payroll_officer', 'hr', 'super_admin'), wrap(async (req, res) => sendXlsx(res, `payroll_${req.params.ym}`, PCOLS, await payRows(ymOk(req.params.ym)))));
  app.get('/api/payroll/:ym/summary.pdf', auth('payroll_officer', 'hr', 'super_admin'), wrap(async (req, res) => pdfTable(res, `Payroll-ready summary ${req.params.ym}`, 'Attendance-based summary for ERP entry', PCOLS.map(c => [c, r => r[c]]), await payRows(ymOk(req.params.ym)))));
  // Focus 9: file-based hand-off keeps the live ERP untouched. Map columns to your Focus 9 import template.
  app.get('/api/payroll/:ym/focus9.csv', auth('payroll_officer', 'super_admin'), wrap(async (req, res) => { const rows = await payRows(ymOk(req.params.ym));
    res.type('text/csv').send(['EmployeeCode,PayableDays,UnpaidDays,OvertimeMinutes,Allowances,Deductions', ...rows.map(r => [r.email, r.payable_days, r.unpaid_days, r.ot_minutes, r.allowances, r.deductions].join(','))].join('\n')); }));
  // ---- scheduled jobs: email delivery (if SMTP configured) and HR reminders
  cron.schedule('* * * * *', async () => {
    if (!process.env.SMTP_HOST) return;
    try { const nm = (await import('nodemailer')).default, port = +(process.env.SMTP_PORT || 587);
      const tr = nm.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
      for (const n of await q(`SELECT n.id, n.message, u.email FROM notifications n JOIN users u ON u.id=n.user_id WHERE NOT n.emailed ORDER BY n.id LIMIT 50`)) {
        await tr.sendMail({ from: process.env.MAIL_FROM || 'attendx@localhost', to: n.email, subject: 'AttendX notification', text: n.message }); await q('UPDATE notifications SET emailed=true WHERE id=$1', [n.id]); }
    } catch (e) { console.error('mail error:', e.message); }
  });
  cron.schedule('0 9 * * *', async () => { const [n] = await q(`SELECT (SELECT count(*) FROM corrections WHERE status='pending_hr' AND created_at < now()-interval '2 days') + (SELECT count(*) FROM leaves WHERE status='pending_hr') + (SELECT count(*) FROM overtime_requests WHERE status='pending_hr') c`);
    if (+n.c) await q(`INSERT INTO notifications(user_id,message) SELECT id,$1 FROM users WHERE role='hr' AND active`, [`Reminder: ${n.c} request(s) awaiting HR approval`]); });
}
