import { PLAN_CONFIG, SUB_STATUS } from '../types/constants.js';

export function calculatePlan(role, planType) {
  const plan = PLAN_CONFIG[role]?.[planType];
  if (!plan) throw new Error('Unsupported role/plan');
  const gst = Number((plan.amount * plan.gstRate).toFixed(2));
  return { amount: plan.amount, gst, totalAmount: Number((plan.amount + gst).toFixed(2)) };
}

export async function startFreeTrial(sql, userId, role) {
  const now = new Date();
  const end = new Date(now);
  end.setMonth(end.getMonth() + 1);
  await sql`
    INSERT INTO subscriptions (user_id, role, plan_type, amount, gst, total_amount, start_date, end_date, status, verified)
    VALUES (${userId}, ${role}, 'monthly', 0, 0, 0, ${now.toISOString()}, ${end.toISOString()}, ${SUB_STATUS.ACTIVE}, true)
  `;
}

export async function expireSubscriptions(sql) {
  return sql`
    UPDATE subscriptions
    SET status = ${SUB_STATUS.EXPIRED}
    WHERE status = ${SUB_STATUS.ACTIVE}
      AND end_date < NOW()
  `;
}
