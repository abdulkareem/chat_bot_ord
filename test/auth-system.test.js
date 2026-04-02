import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/api/handlers.js';

test('normalizes email and role', () => {
  assert.equal(__test.normalizeEmail('  ABDULKAREEM@PSMOCOLLEGE.AC.IN '), 'abdulkareem@psmocollege.ac.in');
  assert.equal(__test.normalizeRole('shop owner'), 'SHOP_OWNER');
  assert.equal(__test.normalizeRole('driver'), 'AUTO_DRIVER');
  assert.equal(__test.normalizeVehicleType('auto'), 'AUTO');
  assert.equal(__test.normalizeVehicleType('car'), 'CAR');
  assert.equal(__test.normalizeVehicleCategory('sedan'), 'SEDAN');
});

test('normalizes whatsapp number', () => {
  assert.equal(__test.normalizePhone(' +91 98765-43210 '), '+919876543210');
});

test('otp hashing is deterministic and secure format', async () => {
  const otp = '123456';
  const hashA = await __test.sha256Hex(otp);
  const hashB = await __test.sha256Hex(otp);
  assert.equal(hashA, hashB);
  assert.equal(hashA.length, 64);
  assert.notEqual(hashA, otp);
});

test('generated otp is 6 digits', () => {
  const otp = __test.generateSixDigitOtp();
  assert.match(otp, /^\d{6}$/);
});


test('builds resend email payload using aureliv domain', () => {
  const payload = __test.buildAdminOtpEmailPayload('abdulkareem@psmocollege.ac.in', '654321');
  assert.equal(payload.from, 'noreply@aureliv.in');
  assert.deepEqual(payload.to, ['abdulkareem@psmocollege.ac.in']);
  assert.match(payload.html, /654321/);
});
