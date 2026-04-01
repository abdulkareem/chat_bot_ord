import postgres from 'postgres';

let sql;
export function getDb(env) {
  if (!sql) {
    sql = postgres(env.DATABASE_URL, {
      max: 10,
      connect_timeout: 10,
      idle_timeout: 20
    });
  }
  return sql;
}
