import jwt from 'jsonwebtoken'; import bcrypt from 'bcrypt'; import { q } from './db.js';
export const hash = p => bcrypt.hash(p, 12);
export const verifyPw = (p, h) => bcrypt.compare(p, h);
export async function login(email, password) {
  const [u] = await q(`SELECT * FROM users WHERE email=$1 AND active AND status<>'terminated'`, [email]);
  if (!u || !(await bcrypt.compare(password, u.password_hash))) return null;
  return jwt.sign({ id: u.id, role: u.role, tv: u.token_version }, process.env.JWT_SECRET, { expiresIn: '8h' });
}
// Role and session validity are re-checked in the DB on every request: role changes, terminations and "log out everywhere" apply immediately.
export const auth = (...roles) => async (req, res, next) => {
  try {
    const t = jwt.verify((req.headers.authorization || '').slice(7), process.env.JWT_SECRET);
    const [u] = await q('SELECT role, token_version, active, status FROM users WHERE id=$1', [t.id]);
    if (!u || !u.active || u.status === 'terminated' || u.token_version !== t.tv) throw new Error('session');
    req.user = { id: t.id, role: u.role };
    if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  } catch { res.status(401).json({ error: 'unauthenticated' }); }
};
