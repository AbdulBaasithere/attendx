# API reference (all under /api, JSON, `Authorization: Bearer <token>` except login)
| Method & path | Roles | Purpose |
|---|---|---|
| POST /login | public | `{email,password}` → `{token}` |
| GET /me · POST /me/password · POST /me/logout-all | any | profile; change password / revoke all sessions |
| GET /dashboard · /tasks · /notifications · POST /notifications/read | any | KPIs, my pending approvals, alerts |
| GET /me/attendance | any | my last 62 days |
| POST /punches/import (multipart `file`) | hr, it, admin | CSV import |
| POST /attendance/process `{day}` | hr, it, admin | compute day, raise exceptions |
| GET /attendance/anomalies | hr, manager, admin | exceptions |
| GET/POST /corrections (multipart: day,new_in,new_out,reason,type,attachment) · POST /corrections/:id/decide `{approve,comment}` | any / manager, hr, admin | corrections & regularization |
| GET/POST /leaves · POST /leaves/:id/decide | any / manager, hr, admin | leave (multipart supports attachment) |
| GET/POST /overtime · POST /overtime/:id/decide | any / manager, hr, admin | overtime |
| GET /attachment/:corrections\|leaves\|overtime_requests/:id | owner, their manager, hr, admin | download (audited) |
| GET /meta · POST /departments · /designations · /holidays · DELETE /holidays/:day · PUT /settings/weekly_off | any / hr, admin | org setup |
| GET/POST /users · PATCH /users/:id | field-level by role | profiles (salary: payroll officer/admin only) |
| GET /periods · POST /periods/:ym/close · /authorize · /reopen | hr,admin,payroll · hr,admin · admin · admin | month lifecycle: open → pending_authorization → locked |
| POST /payroll-items · POST /payroll/:ym/run · GET /payroll/:ym | payroll, admin (+hr read) | payroll-ready summary |
| GET /payroll/:ym/export.xlsx · summary.pdf · focus9.csv | payroll, hr, admin (focus9: payroll, admin) | exports |
| GET /analytics?ym= · /reports/monthly/:ym/attendance.pdf · .xlsx | hr, admin, manager (own team), payroll | analytics & reports |
| GET /audit · /audit/verify | admin, it | audit log; hash-chain integrity |
