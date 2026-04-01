export const ROLES = Object.freeze({
  CUSTOMER: 'customer',
  SHOP: 'shop_owner',
  DRIVER: 'driver'
});

export const VERIFICATION_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
});

export const SUB_STATUS = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
  PENDING: 'pending'
});

export const PLAN_CONFIG = Object.freeze({
  driver: {
    monthly: { amount: 49, gstRate: 0.18 },
    yearly: { amount: 499, gstRate: 0.18 }
  },
  shop_owner: {
    monthly: { amount: 89, gstRate: 0.18 },
    yearly: { amount: 899, gstRate: 0.18 }
  }
});
