import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. Example: DATABASE_URL="postgres://..." npm run db:init');
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const schemaSql = await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
    await sql.unsafe(schemaSql);
    console.log('Database schema created/updated successfully.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
