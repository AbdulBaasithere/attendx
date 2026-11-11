import { q } from './db.js';
// Produces payroll-READY summaries (payable days, unpaid days, approved overtime, allowances, deductions).
// Monetary gross/net is computed ONLY if ENABLE_SALARY_CALC=true (off by default).
export async function runPayroll(ym) {
  const [p] = await q('SELECT status FROM periods WHERE ym=$1', [ym]);
  if (p?.status !== 'locked') throw new Error('Month must be closed and authorized before payroll');
  const calc = process.env.ENABLE_SALARY_CALC === 'true';
  for (const u of await q(`SELECT * FROM users WHERE role<>'it_admin' AND active AND status<>'terminated' AND device_user_id IS NOT NULL ORDER BY id`)) {
    const rows = await q(`SELECT d.status, EXISTS(SELECT 1 FROM leaves l WHERE l.user_id=d.user_id AND l.status='approved' AND NOT l.paid AND d.day BETWEEN l.from_date AND l.to_date) unpaid
      FROM daily_attendance d WHERE d.user_id=$1 AND to_char(d.day,'YYYY-MM')=$2`, [u.id, ym]);
    let pay = 0, unp = 0, unresolved = 0;
    for (const r of rows) {
      if (['present', 'holiday', 'weekoff'].includes(r.status)) pay++;
      else if (r.status === 'leave') r.unpaid ? unp++ : pay++;
      else { unp++; if (r.status === 'incomplete') unresolved++; }
    }
    const [o] = await q(`SELECT coalesce(sum(minutes),0) m FROM overtime_requests WHERE user_id=$1 AND status='approved' AND to_char(day,'YYYY-MM')=$2`, [u.id, ym]);
    const it = await q(`SELECT kind, sum(amount) a FROM payroll_items WHERE user_id=$1 AND ym=$2 GROUP BY kind`, [u.id, ym]);
    const allow = +it.find(i => i.kind === 'allowance')?.a || 0, ded = +it.find(i => i.kind === 'deduction')?.a || 0;
    let gross = null, net = null;
    if (calc) { const daily = u.base_salary / 26; gross = +u.base_salary + allow + (o.m / 60) * (daily / 8) * 1.25; net = gross - ded - daily * unp; }
    await q(`INSERT INTO payroll_runs(ym,user_id,payable_days,unpaid_days,ot_minutes,allowances,deductions,gross,net,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(ym,user_id) DO UPDATE SET payable_days=$3,unpaid_days=$4,ot_minutes=$5,allowances=$6,deductions=$7,gross=$8,net=$9,detail=$10`,
      [ym, u.id, pay, unp, +o.m, allow, ded, gross?.toFixed(2) ?? null, net?.toFixed(2) ?? null, { processedDays: rows.length, unresolvedMissingPunch: unresolved }]);
  }
}
