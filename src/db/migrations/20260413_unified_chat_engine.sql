BEGIN;

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, role_id)
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  handler_key TEXT NOT NULL,
  launch_stage TEXT NOT NULL DEFAULT 'general',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  current_service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  conversation_stage TEXT NOT NULL DEFAULT 'service_selection',
  last_action TEXT,
  context JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role_assigned ON user_roles(role_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_services_active_stage ON services(is_active, launch_stage);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_updated ON user_sessions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_sessions_service_stage ON user_sessions(current_service_id, conversation_stage);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_service_created ON messages(service_id, created_at DESC);

INSERT INTO roles (id, name, is_active)
VALUES
  ('role_customer', 'customer', TRUE),
  ('role_driver', 'driver', TRUE),
  ('role_vendor', 'vendor', TRUE),
  ('role_admin', 'admin', TRUE)
ON CONFLICT (name) DO NOTHING;

INSERT INTO services (id, name, is_active, handler_key, launch_stage)
VALUES
  ('svc_auto', 'Auto Booking', TRUE, 'autoHandler', 'general'),
  ('svc_shop', 'Local Shopping', TRUE, 'shopHandler', 'general')
ON CONFLICT (name) DO NOTHING;

COMMIT;
