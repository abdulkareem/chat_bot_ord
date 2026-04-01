import postgres from 'postgres';

let sql;

export function getDB(env) {
  if (!sql) {
    sql = postgres(env.DATABASE_URL, {
      fetch,
      max: 1,
      idle_timeout: 0,
      connect_timeout: 10
    });
  }

  return sql;
}

export const getDb = getDB;
