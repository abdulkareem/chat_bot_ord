export const APP_ID = 'vyntaro';

export const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  CUSTOMER: 'CUSTOMER',
  AUTO_DRIVER: 'AUTO_DRIVER',
  SHOP_OWNER: 'SHOP_OWNER'
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
  CUSTOMER: {
    monthly: { amount: 0, gstRate: 0 },
    yearly: { amount: 0, gstRate: 0 }
  },
  AUTO_DRIVER: {
    monthly: { amount: 49, gstRate: 0.18 },
    yearly: { amount: 499, gstRate: 0.18 }
  },
  SHOP_OWNER: {
    monthly: { amount: 89, gstRate: 0.18 },
    yearly: { amount: 899, gstRate: 0.18 }
  },
  SUPER_ADMIN: {
    monthly: { amount: 0, gstRate: 0 },
    yearly: { amount: 0, gstRate: 0 }
  }
});
