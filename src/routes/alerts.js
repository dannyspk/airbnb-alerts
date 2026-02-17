import express from 'express';
import { query } from '../db/index.js';
import { authenticateToken, checkSubscription } from '../middleware/auth.js';
import { addSearchJob } from '../workers/queue.js';

const router = express.Router();

// Get all alerts for user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, alert_type, location, check_in, check_out, 
              price_min, price_max, guests, listing_id, listing_url,
              is_active, last_checked, last_notified, notification_count,
              created_at
       FROM search_alerts 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [req.user.userId]
    );

    res.json({ alerts: result.rows });
  } catch (error) {
    console.error('Get alerts error:', error);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// Create new search alert
router.post('/search', authenticateToken, async (req, res) => {
  try {
    const {
      location,
      check_in,
      check_out,
      ne_lat,
      ne_long,
      sw_lat,
      sw_long,
      price_min,
      price_max,
      guests,
      place_type,
      amenities,
      free_cancellation
    } = req.body;

    // Validate required fields
    if (!location || !check_in || !check_out) {
      return res.status(400).json({ 
        error: 'Location, check-in, and check-out dates are required' 
      });
    }

    // Check subscription limits
    const alertCount = await query(
      'SELECT COUNT(*) FROM search_alerts WHERE user_id = $1 AND is_active = true',
      [req.user.userId]
    );
    
    const maxAlerts = req.user.subscription_tier === 'premium' ? 10 : 1;
    if (parseInt(alertCount.rows[0].count) >= maxAlerts) {
      return res.status(403).json({ 
        error: `Maximum ${maxAlerts} active alerts for ${req.user.subscription_tier} tier` 
      });
    }

    // Create alert
    const result = await query(
      `INSERT INTO search_alerts 
       (user_id, alert_type, location, check_in, check_out, 
        ne_lat, ne_long, sw_lat, sw_long, price_min, price_max, 
        guests, place_type, amenities, free_cancellation)
       VALUES ($1, 'search', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        req.user.userId, location, check_in, check_out,
        ne_lat, ne_long, sw_lat, sw_long,
        price_min, price_max, guests, place_type,
        JSON.stringify(amenities || []), free_cancellation
      ]
    );

    // Add to scraping queue
    await addSearchJob(result.rows[0].id);

    res.status(201).json({
      message: 'Alert created successfully',
      alert: result.rows[0]
    });
  } catch (error) {
    console.error('Create alert error:', error);
    res.status(500).json({ error: 'Failed to create alert' });
  }
});

// Create new listing alert (track specific listing)
router.post('/listing', authenticateToken, async (req, res) => {
  try {
    const { listing_id, listing_url, check_in, check_out } = req.body;

    if (!listing_id || !listing_url) {
      return res.status(400).json({ 
        error: 'Listing ID and URL are required' 
      });
    }

    // Check subscription limits
    const alertCount = await query(
      'SELECT COUNT(*) FROM search_alerts WHERE user_id = $1 AND is_active = true',
      [req.user.userId]
    );
    
    const maxAlerts = req.user.subscription_tier === 'premium' ? 10 : 1;
    if (parseInt(alertCount.rows[0].count) >= maxAlerts) {
      return res.status(403).json({ 
        error: `Maximum ${maxAlerts} active alerts for ${req.user.subscription_tier} tier` 
      });
    }

    // Create alert
    const result = await query(
      `INSERT INTO search_alerts 
       (user_id, alert_type, listing_id, listing_url, check_in, check_out)
       VALUES ($1, 'listing', $2, $3, $4, $5)
       RETURNING *`,
      [req.user.userId, listing_id, listing_url, check_in, check_out]
    );

    res.status(201).json({
      message: 'Listing alert created successfully',
      alert: result.rows[0]
    });
  } catch (error) {
    console.error('Create listing alert error:', error);
    res.status(500).json({ error: 'Failed to create listing alert' });
  }
});

// Update alert
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    const result = await query(
      `UPDATE search_alerts 
       SET is_active = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [is_active, id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({
      message: 'Alert updated successfully',
      alert: result.rows[0]
    });
  } catch (error) {
    console.error('Update alert error:', error);
    res.status(500).json({ error: 'Failed to update alert' });
  }
});

// Delete alert
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      'DELETE FROM search_alerts WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({ message: 'Alert deleted successfully' });
  } catch (error) {
    console.error('Delete alert error:', error);
    res.status(500).json({ error: 'Failed to delete alert' });
  }
});

// Run a search alert immediately (enqueue job)
router.post('/:id/run', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const alertCheck = await query(
      'SELECT id, alert_type, is_active FROM search_alerts WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );

    if (alertCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    const alert = alertCheck.rows[0];
    if (alert.alert_type !== 'search') {
      return res.status(400).json({ error: 'Only search alerts can be executed' });
    }

    if (!alert.is_active) {
      return res.status(400).json({ error: 'Alert is inactive' });
    }

    await addSearchJob(id, 'high');
    res.json({ message: 'Search job queued' });
  } catch (error) {
    console.error('Run alert error:', error);
    res.status(500).json({ error: 'Failed to queue alert' });
  }
});

export default router;
