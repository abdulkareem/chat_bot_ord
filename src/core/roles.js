export const ROLE_MAP = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  SUPERADMIN: 'SUPER_ADMIN',
  CUSTOMER: 'CUSTOMER',
  AUTO_DRIVER: 'AUTO_DRIVER',
  DRIVER: 'AUTO_DRIVER',
  SHOP_OWNER: 'SHOP_OWNER',
  SHOP: 'SHOP_OWNER'
});

export const ROLE_ALIASES = Object.freeze({
  super_admin: 'SUPER_ADMIN',
  superadmin: 'SUPER_ADMIN',
  customer: 'CUSTOMER',
  auto_driver: 'AUTO_DRIVER',
  driver: 'AUTO_DRIVER',
  shop_owner: 'SHOP_OWNER',
  shop: 'SHOP_OWNER'
});

export const VALID_ROLES = Object.freeze([
  'SUPER_ADMIN',
  'CUSTOMER',
  'AUTO_DRIVER',
  'SHOP_OWNER'
]);

export function normalizeRole(inputRole) {
  if (!inputRole || typeof inputRole !== 'string') return null;
  const trimmed = inputRole.trim();
  const upper = trimmed.toUpperCase();
  return ROLE_MAP[upper] || ROLE_ALIASES[trimmed.toLowerCase()] || null;
}

export function isAppUserRole(role) {
  const normalized = normalizeRole(role);
  return normalized === 'CUSTOMER' || normalized === 'AUTO_DRIVER' || normalized === 'SHOP_OWNER';
}
