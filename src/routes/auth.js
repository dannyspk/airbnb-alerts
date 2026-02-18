import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { query } from '../db/index.js';
import { authenticateToken } from '../middleware/auth.js';
import { sendPasswordResetEmail, sendWelcomeEmail } from '../services/email.js';
import logger from '../utils/logger.js';

const router = express.Router();

// ─── Rate limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 10,
  message: { error: 'Too many attempts — please wait 15 minutes and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 5,
  message: { error: 'Too many password reset requests — please wait an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Validation helpers ───────────────────────────────────────────────────────
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

function validatePassword(pw) {
  const errors = [];
  if (!pw || pw.length < 8)      errors.push('At least 8 characters');
  if (!/[A-Za-z]/.test(pw))      errors.push('Must contain a letter');
  if (!/[0-9]/.test(pw))         errors.push('Must contain a number');
  return errors;
}

// ─── Token helpers ────────────────────────────────────────────────────────────
const REFRESH_TTL_MS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10) * 86400 * 1000;

function signAccessToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, subscription_tier: user.subscription_tier },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
}

async function issueRefreshToken(userId, res) {
  const raw   = crypto.randomBytes(64).toString('hex');
  const hash  = crypto.createHash('sha256').update(raw).digest('hex');
  const expAt = new Date(Date.now() + REFRESH_TTL_MS);

  await query(
    `INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hash, userId, expAt]
  );

  res.cookie('refreshToken', raw, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   REFRESH_TTL_MS,
  });
}

function userPayload(user) {
  return {
    id:                user.id,
    email:             user.email,
    display_name:      user.display_name || null,
    avatar_url:        user.avatar_url   || null,
    subscription_tier: user.subscription_tier,
  };
}

// ─── Google OAuth strategy ────────────────────────────────────────────────────
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${process.env.API_BASE_URL}/api/auth/google/callback`,
      scope:        ['profile', 'email'],
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email       = profile.emails?.[0]?.value?.toLowerCase();
        const googleId    = profile.id;
        const displayName = profile.displayName;
        const avatarUrl   = profile.photos?.[0]?.value || null;

        if (!email) return done(new Error('No email returned from Google'));

        // Find existing user by google_id or email
        let userRes = await query(
          `SELECT id, email, subscription_tier, display_name, avatar_url
           FROM users WHERE google_id = $1 OR lower(email) = $2
           LIMIT 1`,
          [googleId, email]
        );

        let user;
        if (userRes.rows.length > 0) {
          // Update Google metadata and mark email verified
          const updated = await query(
            `UPDATE users
             SET google_id = $1, display_name = $2, avatar_url = $3,
                 email_verified = true, updated_at = CURRENT_TIMESTAMP
             WHERE id = $4
             RETURNING id, email, subscription_tier, display_name, avatar_url`,
            [googleId, displayName, avatarUrl, userRes.rows[0].id]
          );
          user = updated.rows[0];
        } else {
          // New user via Google — no password_hash
          const created = await query(
            `INSERT INTO users (email, google_id, display_name, avatar_url, email_verified)
             VALUES ($1, $2, $3, $4, true)
             RETURNING id, email, subscription_tier, display_name, avatar_url`,
            [email, googleId, displayName, avatarUrl]
          );
          user = created.rows[0];
          // Fire-and-forget welcome email
          sendWelcomeEmail(user.email).catch(() => {});
        }

        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  ));

  router.use(passport.initialize());

  // Step 1: redirect to Google
  router.get('/google',
    passport.authenticate('google', { session: false, scope: ['profile', 'email'] })
  );

  // Step 2: Google redirects back here
  router.get('/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/auth.html?error=google_failed' }),
    async (req, res) => {
      try {
        const user        = req.user;
        const accessToken = signAccessToken(user);
        await issueRefreshToken(user.id, res);

        // Redirect to frontend with token in query param (picked up by auth.js)
        res.redirect(`/?token=${encodeURIComponent(accessToken)}`);
      } catch (err) {
        logger.error('Google callback error:', err);
        res.redirect('/auth.html?error=server');
      }
    }
  );
} else {
  logger.warn('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google login disabled');
}

// ─── Register ─────────────────────────────────────────────────────────────────
router.post('/register', authLimiter, async (req, res) => {
  try {
    const email    = (req.body.email    || '').trim().toLowerCase();
    const password = (req.body.password || '');

    if (!isValidEmail(email))
      return res.status(400).json({ error: 'Invalid email address' });

    const pwdErrors = validatePassword(password);
    if (pwdErrors.length)
      return res.status(400).json({ error: pwdErrors.join('; ') });

    const existing = await query(
      'SELECT id FROM users WHERE lower(email) = $1', [email]
    );
    if (existing.rows.length)
      return res.status(409).json({ error: 'An account with that email already exists.' });

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, subscription_tier`,
      [email, passwordHash]
    );
    const user = result.rows[0];

    const accessToken = signAccessToken(user);
    await issueRefreshToken(user.id, res);

    sendWelcomeEmail(user.email).catch(() => {});

    res.status(201).json({ token: accessToken, user: userPayload(user) });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'An account with that email already exists.' });
    logger.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed — please try again.' });
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  try {
    const email    = (req.body.email    || '').trim().toLowerCase();
    const password = (req.body.password || '');

    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    const result = await query(
      `SELECT id, email, password_hash, subscription_tier, display_name, avatar_url
       FROM users WHERE lower(email) = $1`,
      [email]
    );

    // Constant-time rejection — don't reveal whether the account exists
    const user = result.rows[0];
    const dummyHash = '$2b$12$invalidhashfortimingprotection000000000000000000000000';
    const hashToCheck = user?.password_hash || dummyHash;
    const valid = await bcrypt.compare(password, hashToCheck);

    if (!user || !valid)
      return res.status(401).json({ error: 'Incorrect email or password.' });

    if (!user.password_hash)
      return res.status(400).json({
        error: 'This account uses Google sign-in. Please continue with Google.'
      });

    const accessToken = signAccessToken(user);
    await issueRefreshToken(user.id, res);

    res.json({ token: accessToken, user: userPayload(user) });
  } catch (err) {
    logger.error('Login error:', err);
    res.status(500).json({ error: 'Login failed — please try again.' });
  }
});

// ─── Refresh ──────────────────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const raw = req.cookies?.refreshToken;
    if (!raw) return res.status(401).json({ error: 'No refresh token' });

    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const rows = await query(
      'SELECT user_id, expires_at FROM refresh_tokens WHERE token_hash = $1',
      [hash]
    );

    if (!rows.rows.length) {
      res.clearCookie('refreshToken');
      return res.status(403).json({ error: 'Invalid refresh token' });
    }

    if (new Date(rows.rows[0].expires_at) < new Date()) {
      await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash]);
      res.clearCookie('refreshToken');
      return res.status(403).json({ error: 'Refresh token expired — please sign in again.' });
    }

    // Rotate: delete old, issue new
    await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash]);

    const userRes = await query(
      'SELECT id, email, subscription_tier, display_name, avatar_url FROM users WHERE id = $1',
      [rows.rows[0].user_id]
    );
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });

    const user        = userRes.rows[0];
    const accessToken = signAccessToken(user);
    await issueRefreshToken(user.id, res);

    res.json({ token: accessToken, user: userPayload(user) });
  } catch (err) {
    logger.error('Refresh error:', err);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const raw = req.cookies?.refreshToken;
    if (raw) {
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash]);
    }
    res.clearCookie('refreshToken');
    res.json({ message: 'Logged out' });
  } catch (err) {
    logger.error('Logout error:', err);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ─── Forgot password ──────────────────────────────────────────────────────────
router.post('/forgot-password', resetLimiter, async (req, res) => {
  // Always return 200 so we don't reveal whether an account exists
  const genericOk = { message: "If that email is registered you'll receive a reset link shortly." };

  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.json(genericOk);

    const userRes = await query(
      'SELECT id FROM users WHERE lower(email) = $1', [email]
    );
    if (!userRes.rows.length) return res.json(genericOk);

    const user = userRes.rows[0];

    // Invalidate any existing unused reset tokens for this user
    await query(
      `DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    );

    const raw     = crypto.randomBytes(32).toString('hex');
    const hash    = crypto.createHash('sha256').update(raw).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await query(
      `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [hash, user.id, expires]
    );

    const resetUrl = `${process.env.API_BASE_URL}/auth.html?mode=reset&token=${raw}`;
    await sendPasswordResetEmail(email, resetUrl);

    res.json(genericOk);
  } catch (err) {
    logger.error('Forgot password error:', err);
    res.json(genericOk); // Still return 200 — don't leak errors
  }
});

// ─── Reset password ───────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password)
      return res.status(400).json({ error: 'Token and new password are required.' });

    const pwdErrors = validatePassword(password);
    if (pwdErrors.length)
      return res.status(400).json({ error: pwdErrors.join('; ') });

    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const tokenRes = await query(
      `SELECT user_id, expires_at, used_at
       FROM password_reset_tokens WHERE token_hash = $1`,
      [hash]
    );

    if (!tokenRes.rows.length)
      return res.status(400).json({ error: 'Invalid or expired reset link.' });

    const row = tokenRes.rows[0];
    if (row.used_at)
      return res.status(400).json({ error: 'This reset link has already been used.' });
    if (new Date(row.expires_at) < new Date())
      return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });

    const passwordHash = await bcrypt.hash(password, 12);

    await query(
      `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [passwordHash, row.user_id]
    );

    // Mark token as used
    await query(
      `UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE token_hash = $1`,
      [hash]
    );

    // Revoke all refresh tokens so any stolen sessions are invalidated
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [row.user_id]);

    res.json({ message: 'Password updated successfully. You can now sign in.' });
  } catch (err) {
    logger.error('Reset password error:', err);
    res.status(500).json({ error: 'Password reset failed — please try again.' });
  }
});

// ─── Me ───────────────────────────────────────────────────────────────────────
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, email, display_name, avatar_url, subscription_tier,
              subscription_status, email_verified, created_at
       FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    logger.error('Get me error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

export default router;
