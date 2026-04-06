BEGIN;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('SUPER_ADMIN','CUSTOMER','VENDOR','DRIVER','SERVICE_PROVIDER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE onboarding_status AS ENUM ('pending','approved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE sub_plan AS ENUM ('monthly','yearly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE sub_status AS ENUM ('pending','active','expired','failed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  role user_role NOT NULL DEFAULT 'CUSTOMER',
  terms_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  privacy_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_status onboarding_status NOT NULL DEFAULT 'pending',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  last_login TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  location JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(app_id, user_id, device_id)
);

CREATE TABLE IF NOT EXISTS otp_verifications (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  phone TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expiry TIMESTAMPTZ NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  purpose TEXT NOT NULL DEFAULT 'login',
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role user_role NOT NULL,
  plan_type sub_plan NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  total_amount NUMERIC(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status sub_status NOT NULL DEFAULT 'pending',
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  razorpay_signature TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendor_profiles (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  shop_name TEXT NOT NULL,
  category TEXT NOT NULL,
  contact_details TEXT,
  working_hours TEXT,
  address TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS driver_profiles (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  vehicle_type TEXT NOT NULL,
  license_details TEXT,
  availability TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_profiles (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,
  service_area TEXT NOT NULL,
  experience_years INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  phone TEXT NOT NULL,
  device_id TEXT,
  country_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, phone)
);

CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  customer_id BIGINT NOT NULL REFERENCES users(id),
  target_user_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_role_visibility ON users (app_id, role, onboarding_status, active);
CREATE INDEX IF NOT EXISTS idx_subscriptions_lookup ON subscriptions (app_id, user_id, status, end_date DESC);
CREATE INDEX IF NOT EXISTS idx_devices_lookup ON devices (app_id, user_id, device_id, last_login DESC);
CREATE INDEX IF NOT EXISTS idx_otp_phone_created ON otp_verifications (app_id, phone, created_at DESC);

COMMIT;
