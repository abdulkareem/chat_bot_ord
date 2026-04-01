import postgres from 'postgres';
import { normalizeRole, VALID_ROLES } from '../src/core/roles.js';

const roleMap = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  COLLEGE: 'COLLEGE_COORDINATOR',
  COORDINATOR: 'COLLEGE_COORDINATOR',
  DEPARTMENT: 'DEPARTMENT_COORDINATOR',
  DEPARTMENT_COORDINATOR: 'DEPARTMENT_COORDINATOR',
  INDUSTRY: 'IPO',
  STUDENT: 'STUDENT',
  EXTERNAL_STUDENT: 'STUDENT'
};

async function migrateRoles() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    await sql.begin(async (trx) => {
      await trx`ALTER TABLE users ALTER COLUMN role TYPE TEXT USING role::text`;
      await trx`ALTER TABLE subscriptions ALTER COLUMN role TYPE TEXT USING role::text`;
      await trx`DROP TYPE IF EXISTS user_role`;
      await trx`CREATE TYPE user_role AS ENUM ('SUPER_ADMIN','ADMIN','COLLEGE_COORDINATOR','DEPARTMENT_COORDINATOR','IPO','STUDENT')`;

      const users = await trx`SELECT id, role FROM users`;
      for (const user of users) {
        const mappedRole = roleMap[user.role] || normalizeRole(user.role);
        if (!mappedRole || !VALID_ROLES.includes(mappedRole)) throw new Error(`Unmapped user role: ${user.role}`);
        await trx`UPDATE users SET role = ${mappedRole} WHERE id = ${user.id}`;
      }

      const subscriptions = await trx`SELECT id, role FROM subscriptions`;
      for (const row of subscriptions) {
        const mappedRole = roleMap[row.role] || normalizeRole(row.role);
        if (!mappedRole || !VALID_ROLES.includes(mappedRole)) throw new Error(`Unmapped subscription role: ${row.role}`);
        await trx`UPDATE subscriptions SET role = ${mappedRole} WHERE id = ${row.id}`;
      }

      await trx`ALTER TABLE users ALTER COLUMN role TYPE user_role USING role::user_role`;
      await trx`ALTER TABLE subscriptions ALTER COLUMN role TYPE user_role USING role::user_role`;

      const [{ cnt }] = await trx`SELECT COUNT(*)::int AS cnt FROM users WHERE role::text NOT IN (${trx(VALID_ROLES)})`;
      if (cnt > 0) throw new Error(`Invalid rows remaining after migration: ${cnt}`);
    });

    console.log('Role migration completed successfully.');
  } finally {
    await sql.end();
  }
}

migrateRoles().catch((error) => {
  console.error(error);
  process.exit(1);
});
