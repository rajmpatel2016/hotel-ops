# Hotel Ops

Daily operations for select-service hotels. This first version covers:

- **Housekeeping board**: set each room to checkout, stayover, vacant or out of order, and assign a housekeeper for the day. Paste room numbers from the PMS, split rooms evenly, adjust by hand.
- **Room sheets**: one printable page per housekeeper, for checkouts, stayovers, or both.
- **Maintenance log**: anyone can log a request. Maintenance starts it, marks it fixed, or marks it "cannot fix" with a reason.
- **Needs GM**: every "cannot fix" request waits here until the GM decides: outside vendor, send back, or close.
- **Schedule**: a weekly grid by department. Click a day to set a shift, apply it to several days at once, copy last week, print. Paid hours total per person, per department and per day; anyone over 40 hours is marked overtime. Housekeepers scheduled for a day are pre-ticked on that day's board.
- **Staff**: load the ADP roster report (CSV), add or remove people by hand, move people between categories.
- **Admin**: hotels and sign-ins. Each sign-in belongs to one hotel, except corporate admins, who see all of them.

## Roles

| Role | Can do |
|---|---|
| Corporate admin | Everything, at every hotel |
| General manager | Everything at their hotel |
| Housekeeping manager | Board, room sheets, housekeeping schedule, staff list, log maintenance requests |
| Maintenance | Maintenance log |

A person tied to one hotel cannot open or change another hotel's data.

## Staff roster rules

- The ADP report is the baseline. Each load adds new people, updates departments and titles, and marks anyone missing as "no longer on the payroll report".
- Changes a manager makes by hand always win: a removed person stays removed, and a hand-set category is never overwritten.
- Removing someone hides them from assignment lists. Their past assignments are kept.
- A hand-added person is linked to payroll when they later appear on a report (matched by name), and flagged if they still have not appeared after 14 days.
- Only name, payroll ID, department, job title and status are read from the report. Pay, Social Security numbers and any other columns are ignored and never stored.
- The report must be CSV. From Excel, use Save As > CSV.

## Deploying on Render

1. Create a Render account and connect it to GitHub.
2. New > Blueprint > choose this repository. Render reads `render.yaml` and creates the web service and the database.
3. When asked, enter `ADMIN_NAME`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` (10 characters or more). These create the first corporate admin.
4. Open the service URL and sign in.

Every push to the main branch redeploys automatically.

`data/setup.json` lists the hotels created on the very first start, and their rooms. Rooms listed there are added on any start if they are missing; rooms already in the app are never changed. More hotels are added under Admin, where each hotel's time zone and work-week start day are also set.

## Running locally

Requires Node 20+ and a Postgres database.

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/hotelops \
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' \
npm start
```

Then open http://localhost:3000. `npm test` runs the automated checks.

## Settings

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (required) |
| `SESSION_SECRET` | Long random value that signs sign-in cookies (required in production) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Create the first admin when no users exist |
| `NODE_ENV=production` | Secure cookies; set by `render.yaml` |
| `PGSSL` | `on` or `off` to force database encryption either way |
| `PORT` | Port to listen on (default 3000) |

## Not built yet

Timesheets (actual hours against the schedule), PMS report import, the repair and vendor approval workflow, the obligations and capital registers, and portfolio analytics.
