#!/usr/bin/env node
import { migrate } from './index.js';

// Small wrapper so `npm run migrate` can call a dedicated file (keeps package.json simple).
migrate()
  .then(() => {
    // migrate() already logs success
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration script failed:', err);
    process.exit(1);
  });
