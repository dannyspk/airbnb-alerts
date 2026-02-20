import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

/**
 * Replication Setup Script
 * 
 * This script initializes logical replication from Supabase (primary) to Railway (replica).
 * 
 * Prerequisites:
 * 1. Both databases must exist and be accessible
 * 2. The primary database (Supabase) must support replication
 * 3. PostgreSQL version should be 10+ for logical replication
 */

class ReplicationSetup {
  constructor() {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL (Supabase) is required for replication setup');
    }
    if (!process.env.DATABASE_REPLICA_URL) {
      throw new Error('DATABASE_REPLICA_URL (Railway) is required for replication setup');
    }

    // Primary (Supabase)
    this.primaryPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    // Replica (Railway)
    this.replicaPool = new Pool({
      connectionString: process.env.DATABASE_REPLICA_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
  }

  async log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = {
      info: '✅',
      warn: '⚠️ ',
      error: '❌'
    }[level] || '💬';

    console.log(`[${timestamp}] ${prefix} ${message}`);
  }

  /**
   * Verify both databases are accessible
   */
  async verifyConnectivity() {
    await this.log('Verifying database connectivity...');

    try {
      const primaryClient = await this.primaryPool.connect();
      const versionResult = await primaryClient.query('SELECT version()');
      await this.log(`Primary DB version: ${versionResult.rows[0].version.split(',')[0]}`);
      primaryClient.release();
    } catch (err) {
      await this.log(`Failed to connect to primary: ${err.message}`, 'error');
      throw err;
    }

    try {
      const replicaClient = await this.replicaPool.connect();
      const versionResult = await replicaClient.query('SELECT version()');
      await this.log(`Replica DB version: ${versionResult.rows[0].version.split(',')[0]}`);
      replicaClient.release();
    } catch (err) {
      await this.log(`Failed to connect to replica: ${err.message}`, 'error');
      throw err;
    }
  }

  /**
   * Check if replication is supported on primary
   */
  async checkReplicationSupport() {
    await this.log('Checking replication support...');

    const client = await this.primaryPool.connect();
    try {
      // Check max_wal_senders
      const walResult = await client.query(
        "SELECT setting FROM pg_settings WHERE name = 'max_wal_senders'"
      );

      const walSenders = parseInt(walResult.rows[0]?.setting || 0);
      if (walSenders > 0) {
        await this.log(`✅ Primary supports replication (max_wal_senders: ${walSenders})`);
      } else {
        await this.log(
          'Primary does not support replication (max_wal_senders: 0)',
          'warn'
        );
        await this.log(
          'Note: Supabase usually supports replication by default. Contact support if needed.',
          'warn'
        );
      }

      // Check wal_level
      const walLevelResult = await client.query(
        "SELECT setting FROM pg_settings WHERE name = 'wal_level'"
      );
      const walLevel = walLevelResult.rows[0]?.setting;
      await this.log(`WAL level: ${walLevel}`);

      if (walLevel !== 'logical' && walLevel !== 'replica') {
        await this.log(
          `Warning: WAL level is ${walLevel}, logical replication may require 'logical'`,
          'warn'
        );
      }
    } finally {
      client.release();
    }
  }

  /**
   * Create a replication user on the primary database
   * Note: This is informational - you may need to do this manually on Supabase
   */
  async createReplicationUser(username = 'replicator', password = null) {
    if (!password) {
      await this.log(
        'Skipping replication user creation - use existing credentials',
        'warn'
      );
      return;
    }

    await this.log(`Creating replication user: ${username}`);

    const client = await this.primaryPool.connect();
    try {
      // Check if user exists
      const userCheckResult = await client.query(
        'SELECT 1 FROM pg_user WHERE usename = $1',
        [username]
      );

      if (userCheckResult.rows.length === 0) {
        await client.query(
          `CREATE USER ${username} WITH PASSWORD $1 REPLICATION`,
          [password]
        );
        await this.log(`✅ Created replication user: ${username}`);
      } else {
        await this.log(`User already exists: ${username}`);
      }

      // Grant necessary privileges
      await client.query(
        `GRANT CONNECT ON DATABASE ${process.env.DATABASE_URL.split('/').pop()} TO ${username}`
      );
      await this.log(`✅ Granted privileges to ${username}`);
    } catch (err) {
      await this.log(
        `Could not create replication user (you may need to do this manually): ${err.message}`,
        'warn'
      );
    } finally {
      client.release();
    }
  }

  /**
   * Create a publication on the primary database
   * Publications define which tables to replicate
   */
  async createPublication(publicationName = 'airbnb_alerts_pub') {
    await this.log(`Creating publication: ${publicationName}`);

    const client = await this.primaryPool.connect();
    try {
      // Check if publication exists
      const pubCheckResult = await client.query(
        'SELECT 1 FROM pg_publication WHERE pubname = $1',
        [publicationName]
      );

      if (pubCheckResult.rows.length === 0) {
        // Create publication for all tables
        await client.query(
          `CREATE PUBLICATION ${publicationName} FOR ALL TABLES`
        );
        await this.log(`✅ Created publication: ${publicationName}`);

        // Get list of published tables
        const tablesResult = await client.query(
          'SELECT schemaname, tablename FROM pg_tables WHERE schemaname = $1',
          ['public']
        );

        await this.log(`📋 Published ${tablesResult.rows.length} tables`);
        for (const table of tablesResult.rows) {
          await this.log(`  - ${table.tablename}`);
        }
      } else {
        await this.log(`Publication already exists: ${publicationName}`);
      }
    } catch (err) {
      await this.log(
        `Error creating publication: ${err.message}`,
        'error'
      );
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Create a subscription on the replica database
   * Subscriptions connect to publications and pull changes
   */
  async createSubscription(
    subscriptionName = 'airbnb_alerts_sub',
    publicationName = 'airbnb_alerts_pub'
  ) {
    await this.log(`Creating subscription: ${subscriptionName}`);

    const client = await this.replicaPool.connect();
    try {
      // Check if subscription exists
      const subCheckResult = await client.query(
        'SELECT 1 FROM pg_subscription WHERE subname = $1',
        [subscriptionName]
      );

      if (subCheckResult.rows.length === 0) {
        // Get connection string for primary
        const primaryConnStr = process.env.DATABASE_URL;

        // Create subscription
        await client.query(
          `CREATE SUBSCRIPTION ${subscriptionName}
           CONNECTION $1
           PUBLICATION ${publicationName}`
          ,
          [primaryConnStr]
        );

        await this.log(`✅ Created subscription: ${subscriptionName}`);

        // Check subscription status
        const statusResult = await client.query(
          'SELECT subname, subenabled FROM pg_subscription WHERE subname = $1',
          [subscriptionName]
        );

        if (statusResult.rows.length > 0) {
          const sub = statusResult.rows[0];
          await this.log(`  Subscription enabled: ${sub.subenabled}`);
        }
      } else {
        await this.log(`Subscription already exists: ${subscriptionName}`);
      }
    } catch (err) {
      await this.log(
        `Error creating subscription: ${err.message}`,
        'error'
      );
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Check replication slots on primary
   */
  async checkReplicationSlots() {
    await this.log('Checking replication slots...');

    const client = await this.primaryPool.connect();
    try {
      const result = await client.query(
        'SELECT slot_name, slot_type, active FROM pg_replication_slots'
      );

      if (result.rows.length === 0) {
        await this.log('No active replication slots');
      } else {
        await this.log(`Found ${result.rows.length} replication slot(s):`);
        for (const slot of result.rows) {
          const status = slot.active ? '✅ Active' : '⚠️  Inactive';
          await this.log(`  - ${slot.slot_name} (${slot.slot_type}) ${status}`);
        }
      }
    } finally {
      client.release();
    }
  }

  /**
   * Check replication status on replica
   */
  async checkReplicationStatus() {
    await this.log('Checking replica replication status...');

    const client = await this.replicaPool.connect();
    try {
      const result = await client.query(
        'SELECT subname, subenabled, subconninfo FROM pg_subscription'
      );

      if (result.rows.length === 0) {
        await this.log('No subscriptions found');
      } else {
        await this.log(`Found ${result.rows.length} subscription(s):`);
        for (const sub of result.rows) {
          const status = sub.subenabled ? '✅ Enabled' : '⚠️  Disabled';
          await this.log(`  - ${sub.subname} ${status}`);
        }
      }

      // Check lag if possible
      const lagResult = await client.query(
        'SELECT NOW() - pg_last_xact_replay_timestamp() AS replication_lag'
      );

      if (lagResult.rows.length > 0) {
        const lag = lagResult.rows[0].replication_lag;
        if (lag) {
          await this.log(`Replication lag: ${lag}`);
        }
      }
    } catch (err) {
      await this.log(
        `Could not check replication status: ${err.message}`,
        'warn'
      );
    } finally {
      client.release();
    }
  }

  /**
   * Full setup process
   */
  async run() {
    try {
      await this.log('🚀 Starting replication setup');

      // Verification
      await this.verifyConnectivity();
      await this.checkReplicationSupport();

      // Setup primary
      await this.createPublication();

      // Setup replica
      await this.createSubscription();

      // Verify
      await this.checkReplicationSlots();
      await this.checkReplicationStatus();

      await this.log('✅ Replication setup completed successfully!');
    } catch (err) {
      await this.log(`Setup failed: ${err.message}`, 'error');
      throw err;
    } finally {
      await this.close();
    }
  }

  async close() {
    try {
      await this.primaryPool.end();
      await this.replicaPool.end();
      await this.log('✅ Database connections closed');
    } catch (err) {
      await this.log(`Error closing connections: ${err.message}`, 'warn');
    }
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const setup = new ReplicationSetup();

  setup
    .run()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Setup failed:', err);
      process.exit(1);
    });
}

export default ReplicationSetup;
