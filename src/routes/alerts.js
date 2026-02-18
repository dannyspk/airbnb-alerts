import express from 'express';
import { query } from '../db/index.js';
import { authenticateToken } from '../middleware/auth.js';
import { addSearchJob, addListingJob } from '../workers/queue.js';

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseAirbnbUrl(raw) {
  let parsed;
  try {
    const href = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
    parsed = new URL(href);
  } catch {
    throw new Error('Could not parse URL — please copy it directly from your browser bar.');
  }

  const host = parsed.hostname.replace(/^www\./, '');
  if (host !== 'airbnb.com' && !host.endsWith('.airbnb.com')) {
    throw new Error('URL must be from airbnb.com');
  }

  const p    = parsed.searchParams;
  const path = parsed.pathname;

  // /rooms/<id>
  const roomMatch = path.match(/^\/rooms\/([\w-]+)/);
  if (roomMatch) {
    const listing_id = roomMatch[1];
    return {
      type:        'listing',
      listing_id,
      listing_url: `https://www.airbnb.com/rooms/${listing_id}`,
      check_in:    p.get('check_in')  || p.get('checkin')  || null,
      check_out:   p.get('check_out') || p.get('checkout') || null,
    };
  }

  // /s/<location>/homes
  const searchMatch = path.match(/^\/s\/([^/]+)/);
  if (searchMatch) {
    const location = decodeURIComponent(searchMatch[1])
      .replace(/--/g, ', ')
      .replace(/-/g, ' ');

    return {
      type:     'search',
      location,
      search_url: raw,
      url_params: {
        check_in:          p.get('checkin')    || p.get('check_in')  || null,
        check_out:         p.get('checkout')   || p.get('check_out') || null,
        ne_lat:            p.get('ne_lat')  ? parseFloat(p.get('ne_lat'))  : null,
        ne_long:           p.get('ne_lng')  ? parseFloat(p.get('ne_lng'))  : null,
        sw_lat:            p.get('sw_lat')  ? parseFloat(p.get('sw_lat'))  : null,
        sw_long:           p.get('sw_lng')  ? parseFloat(p.get('sw_lng'))  : null,
        price_min:         p.get('price_min') ? parseInt(p.get('price_min'), 10) : null,
        price_max:         p.get('price_max') ? parseInt(p.get('price_max'), 10) : null,
        guests:            p.get('adults')    ? parseInt(p.get('adults'),    10) : null,
        place_type:        p.get('room_types[]') || p.get('place_type') || null,
        free_cancellation: p.get('flexible_cancellation') === 'true',
        zoom_value:        p.get('zoom') ? parseInt(p.get('zoom'), 10) : 10,
        currency:          p.get('currency') || 'USD',
        amenities:         p.getAll('amenities[]').map(Number).filter(Boolean),
      },
    };
  }

  throw new Error(
    'Unrecognised Airbnb URL. Please use a search results page (/s/…) or a listing page (/rooms/…).'
  );
}

async function checkAlertLimit(userId) {
  // Check active subscription from DB (source of truth, not JWT)
  const subRes = await query(
    `SELECT plan, status FROM subscriptions WHERE user_id = $1`,
    [userId]
  );
  const sub = subRes.rows[0];
  const isActive = sub && ['active', 'trialing'].includes(sub.status);

  let max = 0; // free / no subscription = 0 alerts
  if (isActive) {
    max = sub.plan === 'premium' ? 10 : 1;
  }

  const countRes = await query(
    'SELECT COUNT(*) FROM search_alerts WHERE user_id = $1 AND is_active = true',
    [userId]
  );
  const count = parseInt(countRes.rows[0].count);
  return { count, max, exceeded: count >= max, isActive };
}

// Enqueue without blocking the HTTP response — fire and forget
function enqueueJob(type, alertId) {
  const fn = type === 'listing' ? addListingJob : addSearchJob;
  fn(alertId).catch(err => console.error(`Failed to enqueue ${type} job for alert ${alertId}:`, err));
}

// ─── GET /api/alerts ──────────────────────────────────────────────────────────
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, alert_type, location, check_in, check_out,
              price_min, price_max, guests, listing_id, listing_url,
              search_url, url_params,
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

// ─── POST /api/alerts/url  (MUST be before /:id routes) ──────────────────────
router.post('/url', authenticateToken, async (req, res) => {
  try {
    const raw = (req.body.search_url || '').trim();
    if (!raw) return res.status(400).json({ error: 'Please provide an Airbnb URL.' });

    let info;
    try {
      info = parseAirbnbUrl(raw);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const limit = await checkAlertLimit(req.user.userId);
    if (!limit.isActive) {
      return res.status(403).json({
        error: 'An active subscription is required to create alerts.',
        upgrade_required: true,
      });
    }
    if (limit.exceeded) {
      return res.status(403).json({
        error: `You've reached the limit of ${limit.max} active alert${limit.max === 1 ? '' : 's'} on your plan. Upgrade to Premium for up to 10.`,
        upgrade_required: true,
      });
    }

    let result;

    if (info.type === 'listing') {
      result = await query(
        `INSERT INTO search_alerts
           (user_id, alert_type, listing_id, listing_url,
            search_url, url_params, check_in, check_out)
         VALUES ($1, 'listing', $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          req.user.userId,
          info.listing_id,
          info.listing_url,
          info.listing_url,
          JSON.stringify({ check_in: info.check_in, check_out: info.check_out }),
          info.check_in,
          info.check_out,
        ]
      );
      enqueueJob('listing', result.rows[0].id);

    } else {
      const up = info.url_params;
      result = await query(
        `INSERT INTO search_alerts
           (user_id, alert_type, search_url, url_params, location,
            check_in, check_out, ne_lat, ne_long, sw_lat, sw_long,
            price_min, price_max, guests, free_cancellation)
         VALUES ($1, 'search', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          req.user.userId, raw, JSON.stringify(up), info.location,
          up.check_in, up.check_out,
          up.ne_lat, up.ne_long, up.sw_lat, up.sw_long,
          up.price_min, up.price_max, up.guests, up.free_cancellation,
        ]
      );
      enqueueJob('search', result.rows[0].id);
    }

    res.status(201).json({
      message: info.type === 'listing'
        ? "Listing alert saved — we'll notify you when it's available for your dates."
        : "Search alert saved — we'll notify you when new listings appear.",
      alert_type: info.type,
      alert: result.rows[0],
    });

  } catch (error) {
    console.error('Create URL alert error:', error);
    res.status(500).json({ error: 'Failed to save alert. Please try again.' });
  }
});

// ─── POST /api/alerts/:id/run ─────────────────────────────────────────────────
router.post('/:id/run', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const alertCheck = await query(
      'SELECT id, alert_type, is_active FROM search_alerts WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );
    if (!alertCheck.rows.length) return res.status(404).json({ error: 'Alert not found' });

    const alert = alertCheck.rows[0];
    if (!alert.is_active) return res.status(400).json({ error: 'Alert is inactive' });

    enqueueJob(alert.alert_type, id);
    res.json({ message: 'Job queued — results will appear shortly.' });
  } catch (error) {
    console.error('Run alert error:', error);
    res.status(500).json({ error: 'Failed to queue alert' });
  }
});

// ─── PUT /api/alerts/:id ──────────────────────────────────────────────────────
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

    if (!result.rows.length) return res.status(404).json({ error: 'Alert not found' });
    res.json({ message: 'Alert updated', alert: result.rows[0] });
  } catch (error) {
    console.error('Update alert error:', error);
    res.status(500).json({ error: 'Failed to update alert' });
  }
});

// ─── DELETE /api/alerts/:id ───────────────────────────────────────────────────
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      'DELETE FROM search_alerts WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Alert not found' });
    res.json({ message: 'Alert deleted' });
  } catch (error) {
    console.error('Delete alert error:', error);
    res.status(500).json({ error: 'Failed to delete alert' });
  }
});

export default router;
