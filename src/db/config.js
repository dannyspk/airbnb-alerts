import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

/**
 * Database Configuration
 * 
 * This module manages both the primary database (Supabase) and read replica (Railway).
 * Supabase acts as the primary database for all writes.
 * Railway acts as the read replica for read-heavy operations (optional for now).
 */

// Validate required environment variables
const requiredEnvVars = ['DATABASE_URL']; // Primary (Supabase)
const optionalEnvVars = ['DATABASE_REPLICA_URL']; // Replica (Railway)

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ ${envVar} environment variable is not set. This is required.`);
    process.exit(1);
  }
}

// Log configuration status
if (process.env.DATABASE_REPLICA_URL) {
  console.log('✅ Primary database (Supabase) configured');
  console.log('✅ Read replica (Railway) configured');
} else {
  console.log('✅ Primary database (Supabase) configured');
  console.warn('⚠️  Read replica not configured. Using primary for all queries.');
}

/**
 * Primary database pool - connects to Supabase
 * This is the source of truth for all writes
 */
const primaryPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: process.env.DB_PRIMARY_POOL_SIZE ? parseInt(process.env.DB_PRIMARY_POOL_SIZE) : 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  application_name: 'airbnb-alerts-primary'
});

/**
 * Read replica pool - connects to Railway (optional)
 * Used for read-only queries to distribute load
 */
let replicaPool = null;
if (process.env.DATABASE_REPLICA_URL) {
  replicaPool = new Pool({
    connectionString: process.env.DATABASE_REPLICA_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: process.env.DB_REPLICA_POOL_SIZE ? parseInt(process.env.DB_REPLICA_POOL_SIZE) : 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    application_name: 'airbnb-alerts-replica'
  });
}

/**
 * Execute a query on the primary database (Supabase)
 * Use for: INSERT, UPDATE, DELETE, and critical reads
 */
export const queryPrimary = (text, params) => primaryPool.query(text, params);

/**
 * Execute a query on the read replica (Railway)
 * Falls back to primary if replica is not configured
 * Use for: SELECT queries that can tolerate slight staleness
 */
export const queryReplica = (text, params) => {
  if (replicaPool) {
    return replicaPool.query(text, params);
  }
  console.warn('Read replica not configured, falling back to primary');
  return primaryPool.query(text, params);
};

/**
 * Execute a query on whichever pool makes sense
 * For write operations: always uses primary
 * For read operations: uses replica if available, otherwise primary
 */
export const query = (text, params, options = {}) => {
  const { forceWrite = false } = options;
  
  // Determine if this is a write operation
  const isWrite = /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s/i.test(text);
  
  // Always use primary for writes or if forced
  if (isWrite || forceWrite) {
    return queryPrimary(text, params);
  }
  
  // Use replica for reads (if available)
  return queryReplica(text, params);
};

/**
 * Get a client from the primary pool
 * Use for transactions and complex multi-statement operations
 */
export const getClientPrimary = () => primaryPool.connect();

/**
 * Get a client from the replica pool
 * Use for read-only operations that don't require the latest data
 */
export const getClientReplica = () => {
  if (replicaPool) {
    return replicaPool.connect();
  }
  console.warn('Read replica not configured, returning primary client');
  return primaryPool.connect();
};

/**
 * Get the appropriate client based on operation type
 * Prefer using this for maximum flexibility
 */
export const getClient = (forceWrite = false) => {
  if (forceWrite) {
    return getClientPrimary();
  }
  return getClientReplica();
};

/**
 * Get connection status for both primary and replica
 */
export async function getConnectionStatus() {
  const status = {
    primary: { connected: false, latency: null, error: null },
    replica: { connected: false, latency: null, error: null }
  };

  // Check primary
  try {
    const startTime = Date.now();
    const client = await primaryPool.connect();
    await client.query('SELECT 1');
    client.release();
    status.primary.connected = true;
    status.primary.latency = Date.now() - startTime;
  } catch (err) {
    status.primary.error = err.message;
  }

  // Check replica
  if (replicaPool) {
    try {
      const startTime = Date.now();
      const client = await replicaPool.connect();
      await client.query('SELECT 1');
      client.release();
      status.replica.connected = true;
      status.replica.latency = Date.now() - startTime;
    } catch (err) {
      status.replica.error = err.message;
    }
  }

  return status;
}

/**
 * Close all database connections gracefully
 */
export async function closeAllConnections() {
  try {
    await primaryPool.end();
    console.log('✅ Primary pool closed');
  } catch (err) {
    console.error('❌ Error closing primary pool:', err);
  }

  if (replicaPool) {
    try {
      await replicaPool.end();
      console.log('✅ Replica pool closed');
    } catch (err) {
      console.error('❌ Error closing replica pool:', err);
    }
  }
}

/**
 * Wait for the primary database to accept connections
 * Retries with exponential backoff
 */
export async function waitForDb(maxRetries = 10, initialDelayMs = 1000) {
  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await primaryPool.connect();
      await client.query('SELECT 1');
      client.release();
      console.log('✅ Primary database connection established');
      return;
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(`Could not connect to primary database after ${maxRetries} attempts: ${err.message}`);
      }
      console.warn(`⏳ Primary database not ready (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms…`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10000);
    }
  }
}

export default {
  query,
  queryPrimary,
  queryReplica,
  getClient,
  getClientPrimary,
  getClientReplica,
  getConnectionStatus,
  closeAllConnections,
  waitForDb
};
