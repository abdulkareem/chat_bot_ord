import { APP_ID } from '../types/constants.js';

export async function pushDailyInsight(sql) {
  const users = await sql`
    SELECT user_id,
      COUNT(*) FILTER (WHERE event_type='order') orders,
      COALESCE(MAX(payload->>'top_item'),'N/A') top_item,
      COALESCE(MAX(payload->>'peak_time'),'N/A') peak_time
    FROM analytics_events
    WHERE app_id = ${APP_ID}
      AND created_at::date = NOW()::date
    GROUP BY user_id
  `;

  for (const row of users) {
    await sql`
      INSERT INTO messages (app_id, chat_id, sender_id, message_type, content)
      SELECT ${APP_ID}, c.id, NULL, 'system', ${JSON.stringify({
        text: `📊 Today: Orders: ${row.orders}, Top Item: ${row.top_item}, Peak Time: ${row.peak_time}`
      })}
      FROM chats c
      WHERE c.app_id = ${APP_ID}
        AND (c.user_a = ${row.user_id} OR c.user_b = ${row.user_id})
      ORDER BY c.updated_at DESC
      LIMIT 1
    `;
  }
}
