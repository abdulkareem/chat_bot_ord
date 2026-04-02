import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

function parseSqlSchema(sqlText) {
  const tableRegex = /CREATE TABLE IF NOT EXISTS\s+([a-zA-Z_][\w]*)\s*\(([^;]*?)\);/gms;
  const tables = {};
  let m;
  while ((m = tableRegex.exec(sqlText))) {
    const table = m[1];
    const body = m[2];
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    const columns = {};
    const pk = [];
    const uniques = [];
    const fks = [];

    for (const raw of lines) {
      const line = raw.replace(/,$/, '');
      if (line.startsWith('UNIQUE(') || line.startsWith('UNIQUE (')) {
        uniques.push(line);
        continue;
      }
      if (/^PRIMARY KEY/i.test(line)) {
        pk.push(line);
        continue;
      }
      const colMatch = line.match(/^([a-zA-Z_][\w]*)\s+(.+)$/);
      if (!colMatch) continue;
      const [, column, rest] = colMatch;
      const type = rest.split(/\s+/)[0];
      columns[column] = {
        type,
        notNull: /\bNOT NULL\b/i.test(rest),
        primaryKey: /\bPRIMARY KEY\b/i.test(rest),
        unique: /\bUNIQUE\b/i.test(rest)
      };
      if (/\bREFERENCES\b/i.test(rest)) {
        const fkMatch = rest.match(/REFERENCES\s+([a-zA-Z_][\w]*)\s*\(([^)]+)\)/i);
        if (fkMatch) {
          fks.push({ column, refTable: fkMatch[1], refColumn: fkMatch[2] });
        }
      }
      if (columns[column].primaryKey) pk.push(column);
      if (columns[column].unique) uniques.push(column);
    }

    tables[table] = { columns, pk, uniques, fks };
  }
  return tables;
}

async function getDatabaseState(sql) {
  const tableRows = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;

  const columns = await sql`
    SELECT table_name, column_name, data_type, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;

  const constraints = await sql`
    SELECT tc.table_name, tc.constraint_name, tc.constraint_type,
           kcu.column_name,
           ccu.table_name AS foreign_table_name,
           ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints tc
    LEFT JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    LEFT JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.table_schema = 'public'
    ORDER BY tc.table_name, tc.constraint_name
  `;

  return { tableRows, columns, constraints };
}

function diffSchema(expected, actual) {
  const actualTables = new Set(actual.tableRows.map((r) => r.table_name));
  const actualColumns = new Map();
  for (const c of actual.columns) {
    const key = `${c.table_name}.${c.column_name}`;
    actualColumns.set(key, c);
  }

  const missingTables = [];
  const missingColumns = [];
  const typeMismatches = [];

  for (const [table, def] of Object.entries(expected)) {
    if (!actualTables.has(table)) {
      missingTables.push(table);
      continue;
    }
    for (const [col, cdef] of Object.entries(def.columns)) {
      const key = `${table}.${col}`;
      const live = actualColumns.get(key);
      if (!live) {
        missingColumns.push({ table, column: col, expectedType: cdef.type });
        continue;
      }
      const liveType = (live.udt_name || live.data_type || '').toLowerCase();
      const exp = cdef.type.toLowerCase();
      if (!(liveType === exp || liveType.includes(exp) || exp.includes(liveType))) {
        typeMismatches.push({ table, column: col, expectedType: cdef.type, actualType: `${live.data_type}/${live.udt_name}` });
      }
    }
  }

  return { missingTables, missingColumns, typeMismatches };
}

function buildMigrationSql(diff, schemaSql) {
  const chunks = [];
  if (diff.missingTables.length) {
    chunks.push('-- Missing tables detected. Reapplying canonical idempotent schema.');
    chunks.push(schemaSql.trim());
  }
  for (const c of diff.missingColumns) {
    chunks.push(`ALTER TABLE ${c.table} ADD COLUMN IF NOT EXISTS ${c.column} ${c.expectedType};`);
  }
  return `BEGIN;\n${chunks.join('\n')}\nCOMMIT;\n`;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const apply = process.argv.includes('--apply');
  const schemaSql = await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
  const prismaSchema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const expected = parseSqlSchema(schemaSql);

  const report = {
    timestamp: new Date().toISOString(),
    schemaSources: ['src/db/schema.sql', 'prisma/schema.prisma'],
    parsedTables: Object.keys(expected),
    prismaSummary: prismaSchema.match(/model\s+\w+/g) || []
  };

  if (!databaseUrl) {
    report.status = 'issues';
    report.error = 'DATABASE_URL is not set. Database introspection/migration skipped.';
    report.migrationSql = '-- Set DATABASE_URL, then run: node scripts/audit-sync.js --apply';
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const actual = await getDatabaseState(sql);
    const diff = diffSchema(expected, actual);
    const migrationSql = buildMigrationSql(diff, schemaSql);

    report.database = {
      tables: actual.tableRows.map((r) => r.table_name),
      tableCount: actual.tableRows.length,
      columnCount: actual.columns.length
    };
    report.diff = diff;
    report.migrationSql = migrationSql;

    if (apply && (diff.missingTables.length || diff.missingColumns.length)) {
      await sql.begin(async (tx) => {
        await tx.unsafe(migrationSql);
      });
      report.applied = true;
    } else {
      report.applied = false;
    }

    report.status = !diff.missingTables.length && !diff.missingColumns.length && !diff.typeMismatches.length ? 'synced' : 'issues';
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
