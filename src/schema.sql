-- Hotel Ops schema. Safe to run on every start (idempotent).

CREATE TABLE IF NOT EXISTS properties (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  code        TEXT,
  timezone    TEXT NOT NULL DEFAULT 'America/New_York',
  is_example  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- People who can sign in.
-- role: admin (all hotels) | gm | housekeeping | maintenance (one hotel)
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','gm','housekeeping','maintenance')),
  property_id   INTEGER REFERENCES properties(id) ON DELETE CASCADE,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id          SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  number      TEXT NOT NULL,
  floor       TEXT NOT NULL DEFAULT '',
  room_type   TEXT NOT NULL DEFAULT '',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (property_id, number)
);

-- Staff who get scheduled and assigned. Not the same as users: most staff never sign in.
-- source: 'adp' (came from a roster report) | 'manual' (added by a manager)
-- removed: a manager took them off the lists. History is kept; imports never undo this.
-- category_locked: a manager set the category by hand; imports never overwrite it.
CREATE TABLE IF NOT EXISTS employees (
  id              SERIAL PRIMARY KEY,
  property_id     INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  payroll_id      TEXT,
  department      TEXT NOT NULL DEFAULT '',
  job_title       TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL DEFAULT 'Other',
  category_locked BOOLEAN NOT NULL DEFAULT FALSE,
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('adp','manual')),
  in_latest_report BOOLEAN NOT NULL DEFAULT TRUE,
  removed         BOOLEAN NOT NULL DEFAULT FALSE,
  removed_at      TIMESTAMPTZ,
  note            TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  matched_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS employees_property_idx ON employees(property_id);

CREATE TABLE IF NOT EXISTS roster_imports (
  id          SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL DEFAULT '',
  imported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rows_read   INTEGER NOT NULL DEFAULT 0,
  added       INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  matched     INTEGER NOT NULL DEFAULT 0,
  dropped     INTEGER NOT NULL DEFAULT 0
);

-- One row per room per day once it has a status or an assignment.
-- status: checkout | stayover | vacant | ooo (out of order)
CREATE TABLE IF NOT EXISTS room_days (
  id          SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_id     INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'vacant' CHECK (status IN ('checkout','stayover','vacant','ooo')),
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  note        TEXT NOT NULL DEFAULT '',
  done        BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, day)
);
CREATE INDEX IF NOT EXISTS room_days_property_day_idx ON room_days(property_id, day);

-- status: open | in_progress | fixed | cannot_fix | closed
-- cannot_fix puts the request in the GM's queue until the GM decides.
CREATE TABLE IF NOT EXISTS maintenance_requests (
  id            SERIAL PRIMARY KEY,
  property_id   INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_id       INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  location      TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL,
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','urgent')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','fixed','cannot_fix','closed')),
  room_out_of_order BOOLEAN NOT NULL DEFAULT FALSE,
  reported_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  flagged_at    TIMESTAMPTZ,
  flag_reason   TEXT NOT NULL DEFAULT '',
  gm_decided_at TIMESTAMPTZ,
  gm_decision   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS maint_property_status_idx ON maintenance_requests(property_id, status);

CREATE TABLE IF NOT EXISTS maintenance_notes (
  id         SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Weekly schedules ----

-- Day the work week starts on: 0 = Sunday ... 6 = Saturday.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS week_start SMALLINT NOT NULL DEFAULT 0;

-- One shift per person per day. A shift that ends at or before its start runs past midnight.
CREATE TABLE IF NOT EXISTS shifts (
  id            SERIAL PRIMARY KEY,
  property_id   INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 30 CHECK (break_minutes BETWEEN 0 AND 240),
  note          TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, day)
);
CREATE INDEX IF NOT EXISTS shifts_property_day_idx ON shifts(property_id, day);
