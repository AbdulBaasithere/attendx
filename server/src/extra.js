import { z } from 'zod'; import { q, audit, canon } from './db.js'; import { auth } from './auth.js';
export function extra(app, { wrap, locked }) {
  app.get('/api/me', auth(), wrap(async (req, res) => res.json((await q('SELECT id,email,role,full_name FROM users WHERE id=$1', [req.user.id]))[0])));
  app.get('/api/users', auth('hr', 'super_admin', 'it_admin', 'manager', 'payroll_officer'), wrap(async (req, res) =>
    res.json(await q(`SELECT u.id,u.email,u.role,u.full_name,u.device_user_id,u.status,u.manager_id,u.dept_id,u.designation_id,g.name designation,CASE WHEN $1 IN ('payroll_officer','super_admin') THEN u.base_salary END base_salary,d.name dept FROM users u LEFT JOIN departments d ON d.id=u.dept_id LEFT JOIN designations g ON g.id=u.designation_id
      WHERE ($1<>'manager' OR u.manager_id=$2) ORDER BY u.id`, [req.user.role, req.user.id]))));
  app.get('/api/dashboard', auth(), wrap(async (req, res) => {
    const [t] = await q(`SELECT count(*) FILTER (WHERE status='present') present, count(*) FILTER (WHERE anomaly IS NOT NULL) anomalies, coalesce(sum(late_min),0) late, coalesce(sum(overtime_min),0) ot
      FROM daily_attendance WHERE day >= date_trunc('month', current_date)::date AND ($1='employee' AND user_id=$2 OR $1<>'employee')`, [req.user.role, req.user.id]);
    const [p] = await q(`SELECT count(*) FROM corrections WHERE status LIKE 'pending%'`);
    res.json({ ...t, pendingCorrections: p.count });
  }));
  app.get('/api/corrections', auth(), wrap(async (req, res) => {
    const r = req.user.role, f = r === 'employee' ? 'c.user_id=$1' : r === 'manager' ? 'u.manager_id=$1' : '$1::int IS NOT NULL';
    res.json(await q(`SELECT c.*, u.full_name FROM corrections c JOIN users u ON u.id=c.user_id WHERE ${f} ORDER BY c.id DESC LIMIT 100`, [req.user.id]));
  }));
  app.get('/api/leaves', auth(), wrap(async (req, res) => {
    const r = req.user.role, f = r === 'employee' ? 'l.user_id=$1' : r === 'manager' ? 'u.manager_id=$1' : '$1::int IS NOT NULL';
    res.json(await q(`SELECT l.*, u.full_name FROM leaves l JOIN users u ON u.id=l.user_id WHERE ${f} ORDER BY l.id DESC LIMIT 100`, [req.user.id]));
  }));
  app.get('/api/periods', auth('hr', 'super_admin', 'payroll_officer'), wrap(async (_r, res) => res.json(await q('SELECT * FROM periods ORDER BY ym DESC'))));
  app.get('/api/payroll/:ym', auth('hr', 'super_admin', 'payroll_officer'), wrap(async (req, res) =>
    res.json(await q('SELECT u.full_name, r.* FROM payroll_runs r JOIN users u ON u.id=r.user_id WHERE ym=$1 ORDER BY u.id', [req.params.ym]))));
  app.post('/api/payroll-items', auth('payroll_officer', 'super_admin'), wrap(async (req, res) => {
    const b = z.object({ user_id: z.number(), ym: z.string().regex(/^\d{4}-\d{2}$/), kind: z.enum(['allowance', 'deduction']), amount: z.number().positive(), note: z.string().optional() }).parse(req.body);
    const [p] = await q('SELECT status FROM periods WHERE ym=$1', [b.ym]); if (p?.status === 'locked') throw new Error('Period locked');
    await q('INSERT INTO payroll_items(user_id,ym,kind,amount,note) VALUES($1,$2,$3,$4,$5)', [b.user_id, b.ym, b.kind, b.amount, b.note]);
    await audit(req.user.id, 'payroll_item', 'payroll_items', b.user_id, b); res.json({ ok: true });
  }));
  app.post('/api/notifications/read', auth(), wrap(async (req, res) => { await q('UPDATE notifications SET read=true WHERE user_id=$1', [req.user.id]); res.json({ ok: true }); }));
  app.get('/api/audit/verify', auth('super_admin', 'it_admin'), wrap(async (_r, res) => {
    const crypto = await import('crypto'); let prev = '', bad = null;
    for (const a of await q('SELECT * FROM audit_log ORDER BY id')) {
      const h = crypto.createHash('sha256').update(prev + canon([a.actor === null ? a.actor : Number(a.actor), a.action, a.entity, a.entity_id, a.payload])).digest('hex');
      if (a.prev_hash !== prev || a.hash !== h) { bad = a.id; break; } prev = a.hash;
    }
    res.json({ intact: bad === null, firstBrokenId: bad });
  }));
}
