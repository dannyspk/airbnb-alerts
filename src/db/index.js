import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

export const query = (text, params) => pool.query(text, params);

export const getClient = () => pool.connect();

// Migration function
export async function migrate() {
  console.log('Running database migrations...');
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');

  // Split SQL file into individual statements and run sequentially so we can
  // ignore 'already exists' errors for idempotent migrations.
  const statements = schema
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    try {
      await pool.query(stmt);
    } catch (err) {
      // Ignore errors for objects that already exist (indexes/tables/etc.)
      // 42P07 = duplicate_table/index, 42710 = duplicate_object
      if (err && (err.code === '42P07' || err.code === '42710')) {
        console.warn('Migration - object already exists, skipping:', err.message);
        continue;
      }
      console.error('❌ Migration error:', err);
      throw err;
    }
  }

  console.log('✅ Database migrations completed successfully');
}

// Run migration if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => {
      console.log('Migration complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}

export default pool;
