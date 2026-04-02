-- Restrict roles and isolate all data to Vyntaro app_id.
ALTER TYPE user_role RENAME TO user_role_old;
CREATE TYPE user_role AS ENUM ('SUPER_ADMIN','CUSTOMER','AUTO_DRIVER','SHOP_OWNER');

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT 'vyntaro',
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS subscription_expired BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users
  ALTER COLUMN role TYPE user_role USING (
    CASE role::text
      WHEN 'IPO' THEN 'AUTO_DRIVER'
      WHEN 'COLLEGE_COORDINATOR' THEN 'SHOP_OWNER'
      WHEN 'STUDENT' THEN 'CUSTOMER'
      WHEN 'SUPER_ADMIN' THEN 'SUPER_ADMIN'
      ELSE 'CUSTOMER'
    END::user_role
  );

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT 'vyntaro',
  ALTER COLUMN role TYPE user_role USING (
    CASE role::text
      WHEN 'IPO' THEN 'AUTO_DRIVER'
      WHEN 'COLLEGE_COORDINATOR' THEN 'SHOP_OWNER'
      WHEN 'STUDENT' THEN 'CUSTOMER'
      WHEN 'SUPER_ADMIN' THEN 'SUPER_ADMIN'
      ELSE 'CUSTOMER'
    END::user_role
  );

DROP TYPE user_role_old;

ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT 'vyntaro';
ALTER TABLE consents ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT 'vyntaro';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT 'vyntaro';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT 'vyntaro';
ALTER TABLE offers ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT 'vyntaro';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT 'vyntaro';
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT 'vyntaro';
ALTER TABLE admin_otps ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT 'vyntaro';
ALTER TABLE verification_documents ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT 'vyntaro';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT 'vyntaro';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT 'vyntaro';

DELETE FROM users WHERE role::text NOT IN ('SUPER_ADMIN','CUSTOMER','AUTO_DRIVER','SHOP_OWNER');

UPDATE subscriptions SET status = 'expired' WHERE app_id = 'vyntaro' AND end_date < NOW();
UPDATE users
SET subscription_expired = true, active = false
WHERE app_id = 'vyntaro'
  AND EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.user_id = users.id
      AND s.app_id = users.app_id
      AND s.status = 'expired'
  );

CREATE INDEX IF NOT EXISTS idx_users_app_id_role ON users(app_id, role);
CREATE INDEX IF NOT EXISTS idx_subscriptions_app_id_end ON subscriptions(app_id, end_date);
