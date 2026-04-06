import { APP_ID, PLAN_TYPES, SUB_STATUS, PAID_ROLES, planPricing } from '../types/constants.js';

export function calculatePlan(role, planType, now = new Date()) {
  if (!PAID_ROLES.has(role)) return { amount: 0, currency: 'INR', totalAmount: 0, billingMonths: 0 };
  if (!Object.values(PLAN_TYPES).includes(planType)) throw new Error('Unsupported plan type');
  const pricing = planPricing(planType, now);
  if (!pricing) throw new Error('Missing pricing');
  return {
    amount: pricing.amountInr,
    currency: pricing.currency,
    totalAmount: pricing.amountInr,
    billingMonths: planType === PLAN_TYPES.YEARLY ? 12 : 1
  };
}

export async function activateSubscription(sql, {
  userId,
  role,
  planType,
  razorpayPaymentId = null,
  razorpayOrderId = null,
  razorpaySignature = null,
  status = SUB_STATUS.ACTIVE,
  now = new Date()
}) {
  const plan = calculatePlan(role, planType, now);
  const end = new Date(now);
  end.setMonth(end.getMonth() + plan.billingMonths);

  const [created] = await sql`
    INSERT INTO subscriptions (
      app_id, user_id, role, plan_type, amount, total_amount, currency,
      start_date, end_date, status,
      razorpay_payment_id, razorpay_order_id, razorpay_signature
    ) VALUES (
      ${APP_ID}, ${userId}, ${role}, ${planType}, ${plan.amount}, ${plan.totalAmount}, ${plan.currency},
      ${now.toISOString()}, ${end.toISOString()}, ${status},
      ${razorpayPaymentId}, ${razorpayOrderId}, ${razorpaySignature}
    ) RETURNING *
  `;
  return created;
}

export async function expireSubscriptions(sql) {
  await sql`
    UPDATE subscriptions
    SET status = ${SUB_STATUS.EXPIRED}
    WHERE app_id = ${APP_ID}
      AND end_date < NOW()
      AND status = ${SUB_STATUS.ACTIVE}
  `;
}
