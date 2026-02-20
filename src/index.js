import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import ConnectPgSimple from 'connect-pg-simple';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import { auditContext } from './utils/auditLog.js';
import { configurePassport } from './middleware/passport.js';
import passport from 'passport';
import { startScheduler } from './scheduler/index.js';
import { waitForDb } from './db/index.js';
import pool from './db/index.js';

// Routes
import authRoutes from './routes/auth.js';
import alertRoutes from './routes/alerts.js';
import listingRoutes from './routes/listings.js';
import billingRoutes from './routes/billing.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Attach audit context to all requests
app.use(auditContext());

// Session configuration (required for Passport.js)
const PgSession = ConnectPgSimple(session);
app.use(
  session({
    store: new PgSession({
      pool: pool,
      tableName: 'session',
      createTableIfMissing: true,
      errorLog: (err) => logger.error('Session store error:', err),
    }),
    secret: process.env.SESSION_SECRET || 'change-this-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // HTTPS only in production
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'lax', // CSRF protection
    },
  })
);

// Configure and initialize Passport.js
configurePassport();
app.use(passport.initialize());
app.use(passport.session());

// Enforce HTTPS in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    // Check if connection is already HTTPS or if it's being proxied through HTTPS
    // x-forwarded-proto is set by Railway/reverse proxies
    if (req.header('x-forwarded-proto') !== 'https' && !req.secure) {
      return res.redirect(301, `https://${req.header('host')}${req.url}`);
    }
    next();
  });
}

// Serve static files
app.use(express.static('public'));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV 
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/billing', billingRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Initialize database and start server
async function start() {
  try {
    // Wait for Postgres to be reachable (handles Railway cold-start race condition)
    await waitForDb();

    // Start scheduler
    startScheduler();
    
    // Start server
    app.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`🔗 API: http://localhost:${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

export default app;
