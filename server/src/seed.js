import { q, pool } from './db.js'; import { hash } from './auth.js';
const pw = await hash(process.env.SEED_PASSWORD || 'Passw0rd!');
const named = async (t, n) => (await q(`INSERT INTO ${t}(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [n]))[0].id;
const D = {}; for (const n of ['Operations', 'Sales', 'Finance', 'Human Resources', 'IT', 'Management']) D[n] = await named('departments', n);
const G = {}; for (const n of ['Director', 'Manager', 'Executive', 'Officer', 'Technician', 'Administrator']) G[n] = await named('designations', n);
await q(`INSERT INTO shifts(name,start_time,end_time) SELECT 'General','09:00','18:00' WHERE NOT EXISTS (SELECT 1 FROM shifts)`);
for (const [d, n] of [['2026-12-02', 'UAE National Day'], ['2026-12-03', 'UAE National Day (2)'], ['2027-01-01', "New Year's Day"]]) await q('INSERT INTO holidays VALUES($1,$2) ON CONFLICT DO NOTHING', [d, n]);
const mk = async (email, role, name, dept, desig, mgr, dev, sal) => { const r = await q(`INSERT INTO users(email,password_hash,role,full_name,dept_id,designation_id,manager_id,device_user_id,base_salary,join_date)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'2024-01-15') ON CONFLICT(email) DO NOTHING RETURNING id`, [email, pw, role, name, D[dept], G[desig], mgr, dev, sal]); return r[0]?.id ?? (await q('SELECT id FROM users WHERE email=$1', [email]))[0].id; };
await mk('admin@demo.com', 'super_admin', 'Super Admin', 'Management', 'Director', null, null, 0);
await mk('hr@demo.com', 'hr', 'HR Lead', 'Human Resources', 'Manager', null, null, 0);
await mk('payroll@demo.com', 'payroll_officer', 'Payroll Officer', 'Finance', 'Officer', null, null, 0);
await mk('it@demo.com', 'it_admin', 'IT Admin', 'IT', 'Administrator', null, null, 0);
const m1 = await mk('manager@demo.com', 'manager', 'Dept Manager', 'Operations', 'Manager', null, '100', 6000);
const m2 = await mk('sales.manager@demo.com', 'manager', 'Sales Manager', 'Sales', 'Manager', null, '200', 6500);
const E = [['emp1', 'Employee One', 'Operations', m1, '101', 3000], ['emp2', 'Employee Two', 'Operations', m1, '102', 3500], ['emp3', 'Employee Three', 'Operations', m1, '103', 2800], ['emp4', 'Employee Four', 'Operations', m1, '104', 3200],
  ['emp5', 'Employee Five', 'Sales', m2, '201', 3600], ['emp6', 'Employee Six', 'Sales', m2, '202', 3400], ['emp7', 'Employee Seven', 'Sales', m2, '203', 3000]];
for (const [e, n, d, m, dev, s] of E) await mk(`${e}@demo.com`, 'employee', n, d, 'Executive', m, dev, s);
console.log('seeded. Login password:', process.env.SEED_PASSWORD || 'Passw0rd!'); await pool.end();
