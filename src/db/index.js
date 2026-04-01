import postgres from 'postgres/cf';

export function getDb(env) {
  return postgres(env.DATABASE_URL, {
    fetch,
    max: 1,
    idle_timeout: 0,
    connect_timeout: 10
  });
}
