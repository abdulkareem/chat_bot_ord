BEGIN;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('SUPER_ADMIN','CUSTOMER','AUTO_DRIVER','SHOP_OWNER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE verification_status AS ENUM ('pending','approved','rejected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE sub_plan AS ENUM ('monthly','yearly');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE sub_status AS ENUM ('active','expired','pending');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE message_type AS ENUM ('text','image','location','offer_card','bill','payment_proof','system');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  name TEXT,
  phone TEXT UNIQUE NOT NULL,
  device_id TEXT,
  role user_role NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  subscription_expired BOOLEAN NOT NULL DEFAULT FALSE,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  is_verified BOOLEAN DEFAULT FALSE,
  is_approved BOOLEAN DEFAULT FALSE,
  verification_status verification_status DEFAULT 'pending',
  documents JSONB DEFAULT '{}'::jsonb,
  discoverable BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shops (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  shop_name TEXT,
  gst_number TEXT,
  shop_photo_url TEXT,
  address TEXT
);

CREATE TABLE IF NOT EXISTS drivers (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  vehicle_type TEXT NOT NULL DEFAULT 'AUTO',
  vehicle_category TEXT,
  vehicle_number TEXT,
  license_number TEXT,
  vehicle_registration_doc_url TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS verification_documents (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  documents JSONB NOT NULL,
  status verification_status DEFAULT 'pending',
  reviewed_by BIGINT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  role user_role NOT NULL,
  plan_type sub_plan NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  gst NUMERIC(10,2) NOT NULL,
  total_amount NUMERIC(10,2) NOT NULL,
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  status sub_status DEFAULT 'pending',
  trial_start TIMESTAMPTZ,
  trial_end TIMESTAMPTZ,
  payment_proof_url TEXT,
  payment_reference TEXT,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  phone TEXT NOT NULL,
  otp TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS consents (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  accepted_terms BOOLEAN NOT NULL DEFAULT FALSE,
  legal_name_usage BOOLEAN NOT NULL DEFAULT FALSE,
  legal_number_usage BOOLEAN NOT NULL DEFAULT FALSE,
  legal_location_usage BOOLEAN NOT NULL DEFAULT FALSE,
  legal_chat_history_usage BOOLEAN NOT NULL DEFAULT FALSE,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chats (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_a BIGINT REFERENCES users(id),
  user_b BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_a, user_b)
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  chat_id BIGINT REFERENCES chats(id) ON DELETE CASCADE,
  sender_id BIGINT REFERENCES users(id),
  message_type message_type NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS offers (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  shop_id BIGINT REFERENCES users(id),
  title TEXT,
  description TEXT,
  radius_km INT DEFAULT 5,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  chat_id BIGINT REFERENCES chats(id),
  user_id BIGINT REFERENCES users(id),
  order_payload JSONB,
  source TEXT,
  confidence NUMERIC(4,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  driver_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  chat_id BIGINT REFERENCES chats(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(app_id, user_id, driver_id)
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT REFERENCES users(id),
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_otps (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  email TEXT NOT NULL,
  otp TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_discovery ON users(app_id, role, active, is_verified, verification_status, discoverable);
CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(app_id, chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_end ON subscriptions(app_id, user_id, end_date DESC);
CREATE INDEX IF NOT EXISTS idx_admin_otps_email_created ON admin_otps(app_id, email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_phone_device ON users(app_id, phone, device_id);
CREATE INDEX IF NOT EXISTS idx_otp_codes_phone_created ON otp_codes(app_id, phone, created_at DESC);

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
  provider TEXT,
  provider_message_id TEXT,
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
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_type TEXT DEFAULT 'AUTO';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_category TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_devices_user_last_login ON devices(app_id, user_id, last_login DESC);
CREATE INDEX IF NOT EXISTS idx_otp_verifications_contact ON otp_verifications(app_id, contact, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_device ON onboarding_sessions(app_id, device_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_verifications_expiry ON otp_verifications(app_id, expiry);
CREATE INDEX IF NOT EXISTS idx_drivers_location ON drivers(app_id, latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_leads_lookup ON leads(app_id, user_id, driver_id, created_at DESC);

COMMIT;
