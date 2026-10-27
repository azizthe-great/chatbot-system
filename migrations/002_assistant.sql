-- Google accounts have no password; password accounts can keep a recovery code.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN google_subject text UNIQUE CHECK (google_subject ~ '^[A-Za-z0-9_-]{1,255}$');
ALTER TABLE users ADD COLUMN recovery_hash text;
ALTER TABLE users ADD CONSTRAINT users_credential_ck CHECK (password_hash IS NOT NULL OR google_subject IS NOT NULL);
-- A Google subject is the identity, so a Google email may match a password account without linking to it.
DROP INDEX users_email_lower_uq;
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email)) WHERE google_subject IS NULL;

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New conversation' CHECK (length(trim(title)) BETWEEN 1 AND 70),
  completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_idx ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 100),
  action text CHECK (action IN ('quote', 'advisor', 'vin', 'tracking')),
  service text CHECK (service IN ('quote', 'advisor', 'vin', 'tracking')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Retried requests reuse their request id, so each one is stored once.
  UNIQUE (conversation_id, request_id, role)
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, seq);

-- Saved estimates outlive the conversation they came from, so message_id is not a foreign key.
CREATE TABLE saved_quotes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  result jsonb NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, message_id)
);
CREATE INDEX saved_quotes_user_idx ON saved_quotes(user_id, saved_at DESC);

-- question_key is the normalized question used to match chat messages.
CREATE TABLE knowledge (
  id uuid PRIMARY KEY,
  question text NOT NULL CHECK (length(trim(question)) BETWEEN 1 AND 1000),
  question_key text NOT NULL UNIQUE,
  answer text NOT NULL CHECK (length(trim(answer)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE unresolved_questions (
  id uuid PRIMARY KEY,
  question text NOT NULL CHECK (length(trim(question)) BETWEEN 1 AND 1000),
  question_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE query_events (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  conversation_id uuid,
  intent text NOT NULL CHECK (intent IN ('quote', 'advisor', 'vin', 'tracking', 'help', 'knowledge', 'unresolved')),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX query_events_created_idx ON query_events(created_at);
