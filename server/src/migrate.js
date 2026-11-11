import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url'; import { pool } from './db.js';
const dir = fileURLToPath(new URL('../../db/', import.meta.url));
await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
const has = (await pool.query(`SELECT to_regclass('public.users') t`)).rows[0].t;
if (has && +(await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count === 0) await pool.query(`INSERT INTO schema_migrations(name) VALUES('001_schema.sql')`);
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
  if ((await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f])).rowCount) continue;
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query(fs.readFileSync(path.join(dir, f), 'utf8')); await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]); await c.query('COMMIT'); console.log('applied', f); }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
process.exit(0);
