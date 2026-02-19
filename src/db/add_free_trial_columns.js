#!/usr/bin/env node
import { query } from './index.js';

async function migrate() {
  console.log('Adding free trial columns to search_alerts table...');
  
  try {
    // Add is_free_trial column
    await query(`
      ALTER TABLE search_alerts 
      ADD COLUMN IF NOT EXISTS is_free_trial BOOLEAN DEFAULT FALSE
    `);
    console.log('✅ Added is_free_trial column');
    
    // Add expires_at column
    await query(`
      ALTER TABLE search_alerts 
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP
    `);
    console.log('✅ Added expires_at column');
    
    console.log('✅ Migration completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

migrate()
  .then(() => {
    console.log('Migration complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });