import { q, pool } from './db.js'; import { importPunches, processDay } from './attendance.js';
const now = new Date(), days = [];
for (let d = 1; d < now.getDate(); d++) { const dt = new Date(now.getFullYear(), now.getMonth(), d); if (![0, 6].includes(dt.getDay())) days.push(dt.toLocaleDateString('en-CA')); }
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const t = (day, h, m) => `${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+04:00`;
const users = await q(`SELECT id, device_user_id FROM users WHERE device_user_id IS NOT NULL ORDER BY id`), rows = [];
users.forEach((u, i) => days.forEach((day, di) => {
  if (i === 2 && di === 1) return;                                           // scripted absence
  rows.push({ device_user_id: u.device_user_id, timestamp: t(day, 9, Math.floor(rnd() * (i % 3 === 0 ? 40 : 12))) });
  if (i === 1 && di === 2) return;                                           // scripted missing out-punch
  rows.push({ device_user_id: u.device_user_id, timestamp: t(day, 17 + (rnd() > .65 ? 1 : 0), 10 + Math.floor(rnd() * 49)) });
  if (i === 0 && di === 0) rows.push({ device_user_id: u.device_user_id, timestamp: t(day, 9, 31) }); // double tap
}));
console.log(await importPunches(rows, 'demo'));
for (const u of users) for (const d of days) await processDay(u.id, d);
const uid = e => q('SELECT id FROM users WHERE email=$1', [e]).then(r => r[0].id);
if (!(await q('SELECT 1 FROM leaves LIMIT 1')).length) {
  const nx = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3).toLocaleDateString('en-CA');
  await q(`INSERT INTO leaves(user_id,from_date,to_date,paid,reason) VALUES($1,$2,$2,true,'Family event')`, [await uid('emp3@demo.com'), nx]);
  await q(`INSERT INTO overtime_requests(user_id,day,minutes,reason) VALUES($1,$2,120,'Quarter-end inventory count')`, [await uid('emp1@demo.com'), days.at(-1)]);
}
console.log('demo data ready:', days.length, 'working days'); await pool.end();
