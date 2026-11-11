import { parse } from 'csv-parse/sync'; import { q } from './db.js';
// CSV columns: device_user_id,timestamp (ISO). Pollers (SDK/ADMS/DB) can call importPunches directly.
export async function importPunches(rows, source = 'csv') {
  let ok = 0, dup = 0, unknown = 0;
  for (const r of rows) {
    const [u] = await q('SELECT id FROM users WHERE device_user_id=$1', [String(r.device_user_id)]);
    if (!u) { unknown++; continue; }
    const res = await q('INSERT INTO punches(user_id,punched_at,source) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [u.id, r.timestamp, source]);
    res.length ? ok++ : dup++;
  }
  return { ok, dup, unknown };
}
export const parseCsv = buf => parse(buf, { columns: true, skip_empty_lines: true, trim: true });
export async function processDay(userId, day) {
  const p = await q(`SELECT punched_at FROM punches WHERE user_id=$1 AND punched_at::date=$2 ORDER BY punched_at`, [userId, day]);
  const [sh] = await q(`SELECT * FROM shifts ORDER BY id LIMIT 1`);
  const [off] = await q(`SELECT (EXTRACT(DOW FROM $1::date)::int = ANY(string_to_array((SELECT value FROM settings WHERE key='weekly_off'),',')::int[])) wo, EXISTS(SELECT 1 FROM holidays WHERE day=$1::date) hol, EXISTS(SELECT 1 FROM leaves WHERE user_id=$2 AND status='approved' AND $1::date BETWEEN from_date AND to_date) lv`, [day, userId]);
  const t = p.map(x => new Date(x.punched_at)).filter((d, i, a) => i === 0 || d - a[i - 1] > 120000); // drop duplicate taps <2min
  let status = off.hol ? 'holiday' : off.wo ? 'weekoff' : off.lv ? 'leave' : 'absent', anomaly = null, worked = 0, late = 0, early = 0, ot = 0, fin = null, lout = null;
  if (t.length) {
    fin = t[0];
    if (t.length === 1) { status = 'incomplete'; anomaly = 'missing_punch'; }
    else {
      lout = t.at(-1); worked = Math.round((lout - fin) / 60000); status = 'present';
      if (t.length % 2) anomaly = 'odd_punch_count';
      if (worked > 16 * 60) anomaly = 'excessive_hours';
      const diff = (d, tm) => (d - new Date(`${day}T${tm}`)) / 60000;
      late = Math.max(0, Math.round(diff(fin, sh.start_time)) - sh.grace_min);
      early = Math.max(0, Math.round(-diff(lout, sh.end_time)));
      ot = Math.max(0, Math.round(diff(lout, sh.end_time))); if (off.wo || off.hol) ot = worked;
    }
  }
  await q(`INSERT INTO daily_attendance(user_id,day,first_in,last_out,worked_min,late_min,early_min,overtime_min,status,anomaly)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id,day) DO UPDATE SET first_in=$3,last_out=$4,worked_min=$5,late_min=$6,early_min=$7,overtime_min=$8,status=$9,anomaly=$10`,
    [userId, day, fin, lout, worked, late, early, ot, status, anomaly]);
}
