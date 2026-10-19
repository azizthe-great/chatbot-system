CREATE TABLE users (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('customer', 'admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE customer_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  phone text,
  address text,
  country text NOT NULL DEFAULT 'Kenya',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  make text NOT NULL CHECK (length(trim(make)) BETWEEN 1 AND 80),
  model text NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 100),
  year integer CHECK (year BETWEEN 1900 AND 2100),
  engine_capacity_cc integer CHECK (engine_capacity_cc BETWEEN 1 AND 20000),
  fuel_type text,
  origin_country text,
  vin text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicles_customer_id_idx ON vehicles(customer_id, created_at DESC);
CREATE UNIQUE INDEX vehicles_customer_vin_uq ON vehicles (customer_id, upper(vin)) WHERE vin IS NOT NULL AND vin <> '';

CREATE TABLE enquiries (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_review', 'waiting_on_customer', 'resolved', 'closed')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enquiries_customer_id_idx ON enquiries(customer_id, created_at DESC);
CREATE INDEX enquiries_status_idx ON enquiries(status, created_at DESC);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  record_type text NOT NULL,
  record_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_actor_idx ON audit_events(actor_id, created_at DESC);
CREATE INDEX audit_events_record_idx ON audit_events(record_type, record_id, created_at DESC);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
