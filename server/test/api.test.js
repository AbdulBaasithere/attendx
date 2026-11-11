// Integration tests: run against a seeded server (npm start) -> `npm test` from /server. Each run uses its own isolated far-future month.
import test from 'node:test'; import assert from 'node:assert/strict';
const B = process.env.BASE_URL || 'http://localhost:4000/api', PW = process.env.SEED_PASSWORD || 'Passw0rd!', YEAR = 2100 + (Date.now() % 7000), YM = `${YEAR}-01`, DAY = `${YEAR}-01-06`; // fresh isolated month per run
const call = async (t, path, body, method) => { const r = await fetch(B + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
const T = {};
test('authentication', async () => {
  for (const u of ['admin', 'hr', 'manager', 'sales.manager', 'emp1', 'payroll', 'it']) T[u] = (await call(null, '/login', { email: u + '@demo.com', password: PW })).j.token, assert.ok(T[u], u);
  assert.equal((await call(null, '/login', { email: 'hr@demo.com', password: 'wrong' })).s, 401);
  assert.equal((await call(null, '/me')).s, 401);
});
test('role-based access and salary visibility', async () => {
  assert.equal((await call(T.emp1, '/users')).s, 403); assert.equal((await call(T.emp1, '/analytics?ym=' + YM)).s, 403);
  assert.equal((await call(T.hr, '/analytics?ym=' + YM)).s, 200); assert.equal((await call(T.hr, '/payroll/' + YM + '/run', {})).s, 403);
  assert.ok((await call(T.hr, '/users')).j.every(u => u.base_salary === null), 'HR must not see salaries');
  assert.ok((await call(T.payroll, '/users')).j.some(u => Number(u.base_salary) > 0), 'Payroll officer sees salaries');
  for (const p of ['/overtime', '/leaves', '/corrections', '/tasks', '/dashboard', '/notifications', '/me/attendance']) assert.equal((await call(T.emp1, p)).s, 200, p);
});
test('overtime: two-level approval and team boundaries', async () => {
  const r = await call(T.emp1, '/overtime', { day: DAY, minutes: 90, reason: 'Month-end stock count' }); assert.equal(r.s, 200); const id = r.j.id;
  assert.equal((await call(T.hr, `/overtime/${id}/decide`, { approve: true })).s, 400, 'HR cannot skip manager');
  assert.equal((await call(T['sales.manager'], `/overtime/${id}/decide`, { approve: true })).s, 400, 'other team manager blocked');
  assert.equal((await call(T.manager, `/overtime/${id}/decide`, { approve: true })).j.status, 'pending_hr');
  assert.equal((await call(T.hr, `/overtime/${id}/decide`, { approve: true })).j.status, 'approved');
});
test('month closure -> authorization -> payroll -> lock -> reopen', async () => {
  assert.equal((await call(T.hr, `/periods/${YM}/close`, {})).s, 200);
  assert.equal((await call(T.payroll, `/payroll/${YM}/run`, {})).s, 400, 'payroll blocked until management authorizes');
  assert.equal((await call(T.hr, `/periods/${YM}/authorize`, {})).s, 403);
  assert.equal((await call(T.admin, `/periods/${YM}/authorize`, { comment: 'Verified' })).s, 200);
  assert.equal((await call(T.payroll, `/payroll/${YM}/run`, {})).s, 200);
  const rows = (await call(T.payroll, `/payroll/${YM}`)).j; assert.equal(rows.find(r => r.full_name === 'Employee One').ot_minutes, 90);
  assert.equal((await call(T.emp1, '/overtime', { day: DAY, minutes: 30, reason: 'Trying after the lock' })).s, 400, 'locked month rejects new requests');
  assert.equal((await call(T.payroll, `/periods/${YM}/close`, {})).s, 403);
  assert.equal((await call(T.hr, `/periods/${YM}/reopen`, { reason: 'HR wants to reopen' })).s, 403);
  assert.equal((await call(T.admin, `/periods/${YM}/reopen`, { reason: 'Test cleanup reopen' })).s, 200);
});
test('exports', async () => {
  for (const p of [`/payroll/${YM}/export.xlsx`, `/payroll/${YM}/summary.pdf`, `/reports/monthly/${YM}/attendance.pdf`, `/reports/monthly/${YM}/attendance.xlsx`]) { const r = await fetch(B + p, { headers: { authorization: 'Bearer ' + T.hr } }); assert.equal(r.status, 200, p); assert.ok((await r.arrayBuffer()).byteLength > 500, p); }
  assert.ok((await (await fetch(B + `/payroll/${YM}/focus9.csv`, { headers: { authorization: 'Bearer ' + T.payroll } })).text()).startsWith('EmployeeCode,PayableDays'));
});
test('audit chain intact', async () => assert.equal((await call(T.admin, '/audit/verify')).j.intact, true));
