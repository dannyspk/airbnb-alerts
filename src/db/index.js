import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is not set.');
  process.exit(1);
}

function makePool(connectionString, label) {
  return new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : false,
    application_name: `airbnb-alerts-${label}`,
  });
}

// Primary: Supabase (DATABASE_URL)
// Replica: Railway (DATABASE_REPLICA_URL) — used as read-only fallback
const primaryPool  = makePool(process.env.DATABASE_URL, 'primary');
const replicaPool  = process.env.DATABASE_REPLICA_URL
  ? makePool(process.env.DATABASE_REPLICA_URL, 'replica')
  : null;

if (replicaPool) {
  console.log('🔁 Replica pool configured (Railway fallback)');
}

// Active write pool — always primary. Swapped to replica only if primary is down.
let activePool = primaryPool;
let usingReplica = false;

// Probe primary on startup and every 60 s; if it's gone switch to replica.
// If primary comes back, switch back automatically.
async function probePrimary() {
  try {
    const client = await primaryPool.connect();
    await client.query('SELECT 1');
    client.release();
    if (usingReplica) {
      console.log('✅ Primary (Supabase) recovered — switching back from replica');
      activePool   = primaryPool;
      usingReplica = false;
    }
  } catch (err) {
    if (!usingReplica && replicaPool) {
      console.error('⚠️  Primary (Supabase) unreachable — failing over to Railway replica:', err.message);
      activePool   = replicaPool;
      usingReplica = true;
    } else if (!replicaPool) {
      console.error('❌ Primary unreachable and no replica configured:', err.message);
    }
  }
}

// Start probing after initial waitForDb completes
let _probeInterval = null;
function startProbing() {
  if (_probeInterval) return;
  _probeInterval = setInterval(probePrimary, 60_000);
}

// pool used by all query() calls — tracks the active pool
const pool = new Proxy({}, {
  get(_, prop) {
    return typeof activePool[prop] === 'function'
      ? activePool[prop].bind(activePool)
      : activePool[prop];
  }
});

/**
 * Wait for the database to accept connections, retrying up to `maxRetries` times
 * with exponential back-off. Useful on platforms like Railway where the Postgres
 * service may still be starting when the app container boots.
 */
export async function waitForDb(maxRetries = 10, initialDelayMs = 1000) {
  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await primaryPool.connect();
      await client.query('SELECT 1');
      client.release();
      console.log('✅ Primary database (Supabase) connected');
      activePool   = primaryPool;
      usingReplica = false;
      startProbing();
      return;
    } catch (err) {
      if (attempt === maxRetries) {
        // Primary exhausted — try replica before giving up
        if (replicaPool) {
          try {
            const rc = await replicaPool.connect();
            await rc.query('SELECT 1');
            rc.release();
            console.warn('⚠️  Primary unavailable — starting on Railway replica');
            activePool   = replicaPool;
            usingReplica = true;
            startProbing(); // keep checking for primary recovery
            return;
          } catch (replicaErr) {
            throw new Error(`Both primary and replica unreachable. Primary: ${err.message}. Replica: ${replicaErr.message}`);
          }
        }
        throw new Error(`Could not connect to database after ${maxRetries} attempts: ${err.message}`);
      }
      console.warn(`⏳ Primary not ready (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms…`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }
}

export const query     = (text, params) => pool.query(text, params);
export const getClient = () => pool.connect();
export const dbStatus  = () => ({ usingReplica, primary: 'Supabase', replica: replicaPool ? 'Railway' : null });

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
