CREATE TABLE shipments (
  id uuid PRIMARY KEY,
  tracking_reference text NOT NULL UNIQUE CHECK (length(trim(tracking_reference)) BETWEEN 8 AND 40),
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  enquiry_id uuid REFERENCES enquiries(id) ON DELETE SET NULL,
  carrier text CHECK (carrier IS NULL OR length(trim(carrier)) BETWEEN 1 AND 120),
  origin_port text NOT NULL CHECK (length(trim(origin_port)) BETWEEN 1 AND 120),
  destination_port text NOT NULL CHECK (length(trim(destination_port)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'purchase_confirmed' CHECK (status IN ('purchase_confirmed','export_processing','awaiting_vessel','departed','in_transit','arrived_destination','customs_clearance','released_delivered')),
  departure_date date,
  estimated_arrival_date date,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (departure_date IS NULL OR estimated_arrival_date IS NULL OR departure_date <= estimated_arrival_date)
);
CREATE INDEX shipments_customer_created_idx ON shipments(customer_id, created_at DESC);
CREATE INDEX shipments_status_updated_idx ON shipments(status, updated_at DESC);

CREATE TABLE shipment_milestones (
  id uuid PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('purchase_confirmed','export_processing','awaiting_vessel','departed','in_transit','arrived_destination','customs_clearance','released_delivered')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
  source text NOT NULL DEFAULT 'manual' CHECK (source = 'manual'),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipment_milestones_history_idx ON shipment_milestones(shipment_id, occurred_at, created_at);
