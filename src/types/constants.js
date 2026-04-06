export const APP_ID = 'vyntaro';

export const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  CUSTOMER: 'CUSTOMER',
  VENDOR: 'VENDOR',
  DRIVER: 'DRIVER',
  SERVICE_PROVIDER: 'SERVICE_PROVIDER'
});

export const PAID_ROLES = new Set([ROLES.VENDOR, ROLES.DRIVER, ROLES.SERVICE_PROVIDER]);

export const ONBOARDING_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
});

export const SUB_STATUS = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
  PENDING: 'pending',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

export const PLAN_TYPES = Object.freeze({
  MONTHLY: 'monthly',
  YEARLY: 'yearly'
});

const INR = (amount) => ({ amountInr: amount, currency: 'INR' });

export const STANDARD_PRICING = Object.freeze({
  [PLAN_TYPES.MONTHLY]: INR(99),
  [PLAN_TYPES.YEARLY]: INR(999)
});

export const LAUNCH_PRICING = Object.freeze({
  [PLAN_TYPES.MONTHLY]: INR(69),
  [PLAN_TYPES.YEARLY]: INR(699)
});

export const LAUNCH_OFFER_END = '2026-05-31T23:59:59.999Z';

export function isLaunchOfferActive(now = new Date()) {
  return now.getTime() <= new Date(LAUNCH_OFFER_END).getTime();
}

export function planPricing(planType, now = new Date()) {
  const source = isLaunchOfferActive(now) ? LAUNCH_PRICING : STANDARD_PRICING;
  return source[planType] || null;
}
