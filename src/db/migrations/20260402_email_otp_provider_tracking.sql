-- Track outbound email OTP provider metadata for audit/debug.
ALTER TABLE otp_verifications
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
