import pg from 'pg'; import crypto from 'crypto'; import 'dotenv/config';
process.env.TZ ||= 'Asia/Dubai'; pg.types.setTypeParser(1082, v => v); // DATE as plain string
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c timezone=${process.env.TZ}` });
export const canon = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x);
export const q = (s, p) => pool.query(s, p).then(r => r.rows);
export async function audit(actor, action, entity, entityId, payload = {}) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query('LOCK TABLE audit_log IN EXCLUSIVE MODE');
    const { rows } = await c.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prev = rows[0]?.hash || '';
    const hash = crypto.createHash('sha256').update(prev + canon([actor, action, entity, String(entityId), payload])).digest('hex');
    await c.query('INSERT INTO audit_log(actor,action,entity,entity_id,payload,prev_hash,hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [actor, action, entity, String(entityId), payload, prev, hash]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
