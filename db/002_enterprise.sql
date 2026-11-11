ALTER TYPE role_t ADD VALUE IF NOT EXISTS 'payroll_officer';
CREATE TABLE designations(id serial PRIMARY KEY, name text UNIQUE NOT NULL);
CREATE TABLE holidays(day date PRIMARY KEY, name text NOT NULL);
CREATE TABLE settings(key text PRIMARY KEY, value text NOT NULL);
INSERT INTO settings VALUES('weekly_off','0,6');
ALTER TABLE users ADD COLUMN designation_id int REFERENCES designations, ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN join_date date, ADD COLUMN totp_secret text, ADD COLUMN token_version int NOT NULL DEFAULT 0;
ALTER TABLE leaves ADD COLUMN reason text, ADD COLUMN attachment_path text;
ALTER TABLE leaves ALTER COLUMN status SET DEFAULT 'pending_manager';
UPDATE leaves SET status='pending_manager' WHERE status='pending';
ALTER TABLE corrections ADD COLUMN type text NOT NULL DEFAULT 'correction';
CREATE TABLE overtime_requests(id serial PRIMARY KEY, user_id int REFERENCES users, day date NOT NULL, minutes int NOT NULL CHECK (minutes>0),
  reason text NOT NULL, attachment_path text, status text NOT NULL DEFAULT 'pending_manager', created_at timestamptz DEFAULT now());
ALTER TABLE periods ADD COLUMN authorized_by int, ADD COLUMN authorized_at timestamptz;
ALTER TABLE payroll_runs ADD COLUMN payable_days numeric(5,1), ADD COLUMN unpaid_days numeric(5,1), ADD COLUMN ot_minutes int, ADD COLUMN allowances numeric(12,2) DEFAULT 0;
ALTER TABLE notifications ADD COLUMN emailed bool DEFAULT true;
ALTER TABLE notifications ALTER COLUMN emailed SET DEFAULT false;
CREATE INDEX ON daily_attendance(day); CREATE INDEX ON punches(user_id, punched_at);
