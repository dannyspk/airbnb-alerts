import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query } from '../db/index.js';
import { authenticateToken } from '../middleware/auth.js';

// Basic validation helpers
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  // simple RFC-like regex (not exhaustive)
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function passwordValidation(password) {
  const errors = [];
  if (!password || typeof password !== 'string') {
    errors.push('Password is required');
    return errors;
  }
  if (password.length < 8) errors.push('Password must be at least 8 characters');
  if (!/[A-Za-z]/.test(password)) errors.push('Password must contain a letter');
  if (!/[0-9]/.test(password)) errors.push('Password must contain a number');
  return errors;
}

const router = express.Router();

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = (email || '').trim().toLowerCase();

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }


    const pwdErrors = passwordValidation(password);
    if (pwdErrors.length > 0) {
      return res.status(400).json({ error: pwdErrors.join('; ') });
    }

    // Check if user exists (case-insensitive)
    const existingUser = await query('SELECT id FROM users WHERE lower(email) = $1', [normalizedEmail]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'User already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, subscription_tier',
      [normalizedEmail, passwordHash]
    );

    const user = result.rows[0];

    // Issue short-lived access token and a refresh token (httpOnly cookie)
    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, subscription_tier: user.subscription_tier },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    // Create refresh token (store hash in DB)
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + (parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10) * 24 * 60 * 60 * 1000));
    await query(
      `INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
      [refreshHash, user.id, expiresAt]
    );

    // Set httpOnly cookie for refresh token
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: (parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10) * 24 * 60 * 60 * 1000)
    });

    res.status(201).json({
      message: 'User created successfully',
      token: accessToken,
      user: { id: user.id, email: user.email, subscription_tier: user.subscription_tier }
    });
  } catch (error) {
    // handle unique-constraint race (duplicate email)
    if (error && error.code === '23505') {
      return res.status(409).json({ error: 'User already exists' });
    }
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = (email || '').trim().toLowerCase();

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Get user (case-insensitive)
    const result = await query(
      'SELECT id, email, password_hash, subscription_tier FROM users WHERE lower(email) = $1',
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Issue short-lived access token + refresh token cookie (rotate on login)
    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, subscription_tier: user.subscription_tier },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    const refreshToken = crypto.randomBytes(64).toString('hex');
    const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + (parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10) * 24 * 60 * 60 * 1000));

    await query(`INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [refreshHash, user.id, expiresAt]);

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: (parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10) * 24 * 60 * 60 * 1000)
    });

    res.json({ message: 'Login successful', token: accessToken, user: { id: user.id, email: user.email, subscription_tier: user.subscription_tier } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Refresh access token using httpOnly refresh token cookie
router.post('/refresh', async (req, res) => {
  try {
    const rawToken = req.cookies && req.cookies.refreshToken;
    if (!rawToken) return res.status(401).json({ error: 'Refresh token required' });

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const rows = await query('SELECT user_id, expires_at FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
    if (rows.rows.length === 0) {
      res.clearCookie('refreshToken');
      return res.status(403).json({ error: 'Invalid refresh token' });
    }

    const dbEntry = rows.rows[0];
    if (new Date(dbEntry.expires_at) < new Date()) {
      await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
      res.clearCookie('refreshToken');
      return res.status(403).json({ error: 'Refresh token expired' });
    }

    // Load user
    const userRes = await query('SELECT id, email, subscription_tier FROM users WHERE id = $1', [dbEntry.user_id]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];

    // Rotate refresh token: delete old, issue new
    await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
    const newRefresh = crypto.randomBytes(64).toString('hex');
    const newHash = crypto.createHash('sha256').update(newRefresh).digest('hex');
    const newExpires = new Date(Date.now() + (parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10) * 24 * 60 * 60 * 1000));
    await query('INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [newHash, user.id, newExpires]);

    // Issue new access token
    const accessToken = jwt.sign({ userId: user.id, email: user.email, subscription_tier: user.subscription_tier }, process.env.JWT_SECRET, { expiresIn: '15m' });

    res.cookie('refreshToken', newRefresh, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: (parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10) * 24 * 60 * 60 * 1000)
    });

    res.json({ token: accessToken, user: { id: user.id, email: user.email, subscription_tier: user.subscription_tier } });
  } catch (err) {
    console.error('Refresh token error:', err);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// Logout - revoke refresh token cookie
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const rawToken = req.cookies && req.cookies.refreshToken;
    if (rawToken) {
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
    }
    res.clearCookie('refreshToken');
    res.json({ message: 'Logged out' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Get current user
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, email, subscription_tier, subscription_status, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

export default router;
