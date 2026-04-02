-- VYNTARO auth + onboarding + admin schema extensions
CREATE TABLE IF NOT EXISTS devices (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  last_login TIMESTAMPTZ DEFAULT NOW(),
  location JSONB DEFAULT '{}'::jsonb,
  UNIQUE(app_id, user_id, device_id)
);

CREATE TABLE IF NOT EXISTS otp_verifications (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  contact TEXT NOT NULL,
  channel TEXT NOT NULL,
  purpose TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expiry TIMESTAMPTZ NOT NULL,
  is_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  contact TEXT NOT NULL,
  device_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(app_id, contact)
);

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS rc_owner TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'pending';

ALTER TABLE shops ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_devices_user_last_login ON devices(app_id, user_id, last_login DESC);
CREATE INDEX IF NOT EXISTS idx_otp_verifications_contact ON otp_verifications(app_id, contact, created_at DESC);
