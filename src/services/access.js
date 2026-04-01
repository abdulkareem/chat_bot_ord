import { SUB_STATUS, VERIFICATION_STATUS } from '../types/constants.js';

export async function canParticipate(sql, userId) {
  const [user] = await sql`
    SELECT id, is_verified, verification_status
    FROM users WHERE id = ${userId}
  `;
  if (!user || !user.is_verified || user.verification_status !== VERIFICATION_STATUS.APPROVED) return false;

  const [sub] = await sql`
    SELECT status, end_date
    FROM subscriptions
    WHERE user_id = ${userId}
    ORDER BY end_date DESC
    LIMIT 1
  `;
  if (!sub) return true; // free-trial case fallback
  return sub.status === SUB_STATUS.ACTIVE && new Date(sub.end_date) >= new Date();
}
