import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/api/handlers.js';
import { isLaunchOfferActive, planPricing } from '../src/types/constants.js';

test('normalizes role variants', () => {
  assert.equal(__test.normalizeRole('vendor'), 'VENDOR');
  assert.equal(__test.normalizeRole('DRIVER'), 'DRIVER');
  assert.equal(__test.normalizeRole('service_provider'), null);
});

test('normalizes phone number', () => {
  assert.equal(__test.normalizePhone('98765-43210', '+91'), '+919876543210');
});

test('otp hash is deterministic', async () => {
  const hashA = await __test.sha256Hex('123456');
  const hashB = await __test.sha256Hex('123456');
  assert.equal(hashA, hashB);
  assert.equal(hashA.length, 64);
});

test('generated otp is 6 digits', () => {
  assert.match(__test.sixDigitOtp(), /^\d{6}$/);
});

test('launch pricing is applied before May 31 2026', () => {
  const now = new Date('2026-05-20T00:00:00.000Z');
  assert.equal(isLaunchOfferActive(now), true);
  assert.equal(planPricing('monthly', now).amountInr, 69);
  assert.equal(planPricing('yearly', now).amountInr, 699);
});
