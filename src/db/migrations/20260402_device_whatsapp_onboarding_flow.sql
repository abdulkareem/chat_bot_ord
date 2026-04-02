ALTER TABLE consents ADD COLUMN IF NOT EXISTS legal_name_usage BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE consents ADD COLUMN IF NOT EXISTS legal_number_usage BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE consents ADD COLUMN IF NOT EXISTS legal_location_usage BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE consents ADD COLUMN IF NOT EXISTS legal_chat_history_usage BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_device ON onboarding_sessions(app_id, device_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_verifications_expiry ON otp_verifications(app_id, expiry);
