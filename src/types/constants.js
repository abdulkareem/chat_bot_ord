export const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  COLLEGE_COORDINATOR: 'COLLEGE_COORDINATOR',
  DEPARTMENT_COORDINATOR: 'DEPARTMENT_COORDINATOR',
  IPO: 'IPO',
  STUDENT: 'STUDENT'
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
  SUPER_ADMIN: {
    monthly: { amount: 0, gstRate: 0 },
    yearly: { amount: 0, gstRate: 0 }
  },
  ADMIN: {
    monthly: { amount: 0, gstRate: 0 },
    yearly: { amount: 0, gstRate: 0 }
  },
  COLLEGE_COORDINATOR: {
    monthly: { amount: 89, gstRate: 0.18 },
    yearly: { amount: 899, gstRate: 0.18 }
  },
  DEPARTMENT_COORDINATOR: {
    monthly: { amount: 69, gstRate: 0.18 },
    yearly: { amount: 699, gstRate: 0.18 }
  },
  IPO: {
    monthly: { amount: 49, gstRate: 0.18 },
    yearly: { amount: 499, gstRate: 0.18 }
  },
  STUDENT: {
    monthly: { amount: 0, gstRate: 0 },
    yearly: { amount: 0, gstRate: 0 }
  }
});
