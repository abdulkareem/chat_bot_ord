import { APP_ID, SUB_STATUS, VERIFICATION_STATUS } from '../types/constants.js';

export async function canParticipate(sql, userId) {
  const [user] = await sql`
    SELECT id, is_verified, verification_status, active
    FROM users
    WHERE id = ${userId}
      AND app_id = ${APP_ID}
  `;
  if (!user || !user.active || !user.is_verified || user.verification_status !== VERIFICATION_STATUS.APPROVED) return false;

  const [sub] = await sql`
    SELECT status, end_date
    FROM subscriptions
    WHERE user_id = ${userId}
      AND app_id = ${APP_ID}
    ORDER BY end_date DESC
    LIMIT 1
  `;
  if (!sub) return true;
  return sub.status === SUB_STATUS.ACTIVE && new Date(sub.end_date) >= new Date();
}
