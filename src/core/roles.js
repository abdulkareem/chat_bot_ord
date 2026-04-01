export const ROLE_MAP = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  COLLEGE: 'COLLEGE_COORDINATOR',
  COORDINATOR: 'COLLEGE_COORDINATOR',
  COLLEGE_COORDINATOR: 'COLLEGE_COORDINATOR',
  DEPARTMENT: 'DEPARTMENT_COORDINATOR',
  DEPARTMENT_COORDINATOR: 'DEPARTMENT_COORDINATOR',
  INDUSTRY: 'IPO',
  IPO: 'IPO',
  STUDENT: 'STUDENT',
  EXTERNAL_STUDENT: 'STUDENT'
});

export const ROLE_ALIASES = Object.freeze({
  customer: 'STUDENT',
  shop_owner: 'COLLEGE_COORDINATOR',
  driver: 'IPO',
  admin: 'ADMIN'
});

export const VALID_ROLES = Object.freeze([
  'SUPER_ADMIN',
  'ADMIN',
  'COLLEGE_COORDINATOR',
  'DEPARTMENT_COORDINATOR',
  'IPO',
  'STUDENT'
]);

export function normalizeRole(inputRole) {
  if (!inputRole || typeof inputRole !== 'string') return null;
  const trimmed = inputRole.trim();
  const upper = trimmed.toUpperCase();
  return ROLE_MAP[upper] || ROLE_ALIASES[trimmed.toLowerCase()] || null;
}
