import test from 'node:test';
import assert from 'node:assert/strict';
import { isLaunchOfferActive, planPricing } from '../src/types/constants.js';

test('launch offer pricing is active before 2026-05-31 end of day UTC', () => {
  const now = new Date('2026-05-20T00:00:00.000Z');
  assert.equal(isLaunchOfferActive(now), true);
  assert.equal(planPricing('monthly', now).amountInr, 69);
  assert.equal(planPricing('yearly', now).amountInr, 699);
});

test('standard pricing is used after launch offer cutoff', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  assert.equal(isLaunchOfferActive(now), false);
  assert.equal(planPricing('monthly', now).amountInr, 99);
  assert.equal(planPricing('yearly', now).amountInr, 999);
});
