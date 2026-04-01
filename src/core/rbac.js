import { json } from './response.js';
import { requireAuth } from './auth.js';
import { normalizeRole } from './roles.js';

export function authorizeRoles(...allowedRoles) {
  const normalizedAllowed = allowedRoles.map((role) => normalizeRole(role)).filter(Boolean);

  return async (req, env) => {
    const auth = await requireAuth(req, env);
    if (!auth) return { error: json({ message: 'Unauthorized' }, 401) };

    const role = normalizeRole(auth.role);
    if (!role || !normalizedAllowed.includes(role)) {
      return { error: json({ message: 'Access denied' }, 403) };
    }

    return { auth: { ...auth, role } };
  };
}
