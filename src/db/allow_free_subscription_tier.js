#!/usr/bin/env node
import { query } from './index.js';

async function migrate() {
  console.log('Updating users.subscription_tier check constraint to allow \"free\"...');
  try {
    // Drop the existing constraint if it exists, then add a new one that includes 'free'
    await query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_subscription_tier_check`);
    await query(`ALTER TABLE users ADD CONSTRAINT users_subscription_tier_check CHECK (subscription_tier IN ('free', 'basic', 'premium'))`);
    console.log('✅ Updated users.subscription_tier check constraint');
  } catch (err) {
    console.error('❌ Failed to update subscription_tier constraint:', err);
    throw err;
  }
}

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
