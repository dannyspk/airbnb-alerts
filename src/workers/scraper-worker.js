import scrapeQueue from './queue.js';
import { query } from '../db/index.js';
import { searchAirbnb } from './python-executor.js';
import { sendNewListingEmail } from '../services/email.js';
import { sendWebhook } from '../services/webhook.js';
import logger from '../utils/logger.js';

/**
 * Build the params object to pass to the Python scraper for a given alert.
 *
 * Both alert types (URL-based search + URL-based listing) end up here.
 * For a /rooms/ listing alert we stored the listing_url as search_url so
 * pyairbnb can still do a targeted search.  For /s/ search alerts we pass
 * the full search URL directly.
 */
function buildSearchParams(alert) {
  // URL-based alerts (primary flow): pass the URL straight through.
  // pyairbnb.search_all() accepts a `url` kwarg and handles all parsing.
  if (alert.search_url) {
    return {
      search_url: alert.search_url,
      currency: (alert.url_params?.currency) || 'USD',
      proxy_url: process.env.PROXY_URL || '',
    };
  }

  // Legacy form-based search alert fallback
  return {
    check_in:          alert.check_in,
    check_out:         alert.check_out,
    ne_lat:            alert.ne_lat,
    ne_long:           alert.ne_long,
    sw_lat:            alert.sw_lat,
    sw_long:           alert.sw_long,
    price_min:         alert.price_min,
    price_max:         alert.price_max,
    guests:            alert.guests || 1,
    place_type:        alert.place_type || '',
    amenities:         alert.amenities || [],
    free_cancellation: alert.free_cancellation || false,
    currency:          'USD',
    proxy_url:         process.env.PROXY_URL || '',
  };
}

/**
 * Core processing logic — shared by every alert type.
 *
 * 1. Fetch current listings matching the alert's criteria
 * 2. Upsert them into the listings cache
 * 3. Diff against previously seen listing IDs for this alert
 * 4. Notify the user about genuinely new listings
 */
async function processAlert(alertId) {
  // Load the alert
  const alertResult = await query(
    `SELECT sa.*, u.email AS user_email
     FROM search_alerts sa
     JOIN users u ON u.id = sa.user_id
     WHERE sa.id = $1 AND sa.is_active = true`,
    [alertId]
  );

  if (alertResult.rows.length === 0) {
    logger.warn(`Alert ${alertId} not found or inactive — skipping`);
    return { status: 'skipped', reason: 'Alert not found or inactive' };
  }

  const alert = alertResult.rows[0];
  const userEmail = alert.user_email;

  // Run the scraper
  const searchParams = buildSearchParams(alert);
  const results = await searchAirbnb(searchParams);
  logger.info(`Alert ${alertId}: scraper returned ${results.length} listings`);

  // Load IDs we have already seen for this alert
  const seenResult = await query(
    `SELECT listing_id FROM search_results WHERE search_alert_id = $1`,
    [alertId]
  );
  const seenIds = new Set(seenResult.rows.map(r => r.listing_id));

  // Upsert each listing into the cache and detect new ones
  const newListings = [];

  for (const listing of results) {
    if (!listing.id) continue; // skip malformed results

    // Cache the listing (create or refresh)
    await query(
      `INSERT INTO listings
         (listing_id, url, name, price, currency, rating, num_reviews,
          room_type, guests, address, lat, lng, host_id, host_name, photos, last_updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CURRENT_TIMESTAMP)
       ON CONFLICT (listing_id) DO UPDATE SET
         price       = EXCLUDED.price,
         rating      = EXCLUDED.rating,
         num_reviews = EXCLUDED.num_reviews,
         last_updated = CURRENT_TIMESTAMP`,
      [
        listing.id, listing.url, listing.name,
        listing.price, listing.currency || 'USD',
        listing.rating, listing.reviewsCount || 0,
        listing.roomType, listing.guests,
        listing.address, listing.lat, listing.lng,
        listing.hostId, listing.hostName,
        JSON.stringify(listing.photos || []),
      ]
    );

    // Record it as seen for this alert
    if (!seenIds.has(listing.id)) {
      await query(
        `INSERT INTO search_results (search_alert_id, listing_id, change_type, new_price)
         VALUES ($1, $2, 'new', $3)
         ON CONFLICT DO NOTHING`,
        [alertId, listing.id, listing.price]
      );
      newListings.push(listing);
    }
  }

  // Always update the last_checked timestamp
  await query(
    `UPDATE search_alerts SET last_checked = CURRENT_TIMESTAMP WHERE id = $1`,
    [alertId]
  );

  // ── Notify ────────────────────────────────────────────────────────────────
  if (newListings.length > 0) {
    logger.info(`Alert ${alertId}: ${newListings.length} new listing(s) — notifying ${userEmail}`);

    // Email
    await sendNewListingEmail(userEmail, alert, newListings);

    // Per-listing notification log + optional webhook
    for (const listing of newListings) {
      let webhookSent = false;
      let webhookError = null;

      if (process.env.WEBHOOK_URL) {
        try {
          const payload = {
            event: 'new_listing',
            alert: {
              id: alert.id,
              type: alert.alert_type,
              location: alert.location,
              check_in: alert.check_in,
              check_out: alert.check_out,
              search_url: alert.search_url || null,
            },
            user: { id: alert.user_id, email: userEmail },
            listing,
            detected_at: new Date().toISOString(),
          };
          const wh = await sendWebhook({
            url: process.env.WEBHOOK_URL,
            secret: process.env.WEBHOOK_SECRET,
            payload,
          });
          webhookSent = !!wh.ok;
          if (!wh.ok) webhookError = wh.error || 'webhook failed';
        } catch (err) {
          webhookError = String(err);
        }
      }

      await query(
        `INSERT INTO notifications
           (user_id, search_alert_id, listing_id, notification_type,
            email_sent, webhook_sent, webhook_error)
         SELECT user_id, $1, $2, 'new_listing', true, $3, $4
         FROM search_alerts WHERE id = $1`,
        [alertId, listing.id, webhookSent, webhookError]
      );
    }

    await query(
      `UPDATE search_alerts
       SET last_notified      = CURRENT_TIMESTAMP,
           notification_count = notification_count + $2
       WHERE id = $1`,
      [alertId, newListings.length]
    );
  }

  return {
    status: 'success',
    alertId,
    totalListings: results.length,
    newListings: newListings.length,
  };
}

// ── Queue processors ──────────────────────────────────────────────────────────
// Both job types run through the same logic now.  The 'listing' job type is
// kept so any previously queued jobs don't error; it just delegates to the
// same processAlert() function instead of using iCal.

scrapeQueue.process('search', async (job) => {
  const { alertId } = job.data;
  try {
    return await processAlert(alertId);
  } catch (error) {
    logger.error(`Search job failed for alert ${alertId}:`, error);
    throw error;
  }
});

scrapeQueue.process('listing', async (job) => {
  const { alertId } = job.data;
  try {
    return await processAlert(alertId);
  } catch (error) {
    logger.error(`Listing job failed for alert ${alertId}:`, error);
    throw error;
  }
});

logger.info('🔄 Worker started — processing search and listing jobs');

export default scrapeQueue;
