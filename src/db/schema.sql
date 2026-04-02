CREATE TYPE user_role AS ENUM ('SUPER_ADMIN','CUSTOMER','AUTO_DRIVER','SHOP_OWNER');
CREATE TYPE verification_status AS ENUM ('pending','approved','rejected');
CREATE TYPE sub_plan AS ENUM ('monthly','yearly');
CREATE TYPE sub_status AS ENUM ('active','expired','pending');
CREATE TYPE message_type AS ENUM ('text','image','location','offer_card','bill','payment_proof','system');

CREATE TABLE users (
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

CREATE TABLE shops (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  shop_name TEXT,
  gst_number TEXT,
  shop_photo_url TEXT,
  address TEXT
);

CREATE TABLE drivers (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  vehicle_number TEXT,
  license_number TEXT,
  vehicle_registration_doc_url TEXT
);

CREATE TABLE verification_documents (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  documents JSONB NOT NULL,
  status verification_status DEFAULT 'pending',
  reviewed_by BIGINT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE subscriptions (
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

CREATE TABLE otp_codes (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  phone TEXT NOT NULL,
  otp TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE consents (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  accepted_terms BOOLEAN NOT NULL DEFAULT FALSE,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE chats (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_a BIGINT REFERENCES users(id),
  user_b BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_a, user_b)
);

CREATE TABLE messages (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  chat_id BIGINT REFERENCES chats(id) ON DELETE CASCADE,
  sender_id BIGINT REFERENCES users(id),
  message_type message_type NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE offers (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  shop_id BIGINT REFERENCES users(id),
  title TEXT,
  description TEXT,
  radius_km INT DEFAULT 5,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  chat_id BIGINT REFERENCES chats(id),
  user_id BIGINT REFERENCES users(id),
  order_payload JSONB,
  source TEXT,
  confidence NUMERIC(4,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE analytics_events (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  user_id BIGINT REFERENCES users(id),
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE admin_otps (
  id BIGSERIAL PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT 'vyntaro',
  email TEXT NOT NULL,
  otp TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_discovery ON users(app_id, role, active, is_verified, verification_status, discoverable);
CREATE INDEX idx_messages_chat_created ON messages(app_id, chat_id, created_at DESC);
CREATE INDEX idx_subscriptions_user_end ON subscriptions(app_id, user_id, end_date DESC);
CREATE INDEX idx_admin_otps_email_created ON admin_otps(app_id, email, created_at DESC);
CREATE INDEX idx_users_phone_device ON users(app_id, phone, device_id);
CREATE INDEX idx_otp_codes_phone_created ON otp_codes(app_id, phone, created_at DESC);
