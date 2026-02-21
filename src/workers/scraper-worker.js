import scrapeQueue from './queue.js';
import { query } from '../db/index.js';
import { searchAirbnb } from './python-executor.js';
import { sendNewListingEmail } from '../services/email.js';
import { checkICalAvailability } from '../services/ical.js';
import logger from '../utils/logger.js';

// ─── Price extraction ────────────────────────────────────────────────────────
// The pyairbnb price object looks like:
// { unit: { qualifier: 'for 7 nights', amount: 418, discount: 367 }, ... }
// 'discount' is the actual price after weekly discounts — use that when present,
// fall back to 'amount', then total.amount, then a raw number.
function extractPrice(price) {
  if (price == null) return null;
  if (typeof price === 'number') return price;
  if (typeof price === 'string') {
    const n = parseFloat(price.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (typeof price === 'object') {
    const unit = price.unit || {};
    // 'discount' = price after weekly discount applied (what Airbnb shows on card)
    if (unit.discount != null) return Number(unit.discount);
    if (unit.amount  != null) return Number(unit.amount);
    if (price.total  && price.total.amount != null) return Number(price.total.amount);
  }
  return null;
}

// ─── Build listing URL ───────────────────────────────────────────────────────
function listingUrl(listing) {
  if (listing.url) return listing.url;
  if (listing.id)  return `https://www.airbnb.com/rooms/${listing.id}`;
  return null;
}

// ─── Main search alert processor ─────────────────────────────────────────────
export async function runSearchAlert(alertId, opts = {}) {
  const {
    searchFn       = searchAirbnb,
    checkICalFn    = checkICalAvailability,
    sendEmailFn    = sendNewListingEmail,
  } = opts;

  logger.info(`Processing search alert ${alertId}`);

  // Load alert
  const alertResult = await query(
    `SELECT * FROM search_alerts WHERE id = $1 AND is_active = true`,
    [alertId]
  );
  if (alertResult.rows.length === 0) {
    logger.warn(`Alert ${alertId} not found or inactive`);
    return { status: 'skipped', reason: 'Alert not found or inactive' };
  }
  const alert = alertResult.rows[0];

  // Parse stored url_params
  let urlParams = null;
  try {
    if (alert.url_params) {
      urlParams = typeof alert.url_params === 'string'
        ? JSON.parse(alert.url_params)
        : alert.url_params;
    }
  } catch (_) { urlParams = null; }

  // ── Build search params for Python ─────────────────────────────────────────
  // Always prefer search_url — our new airbnb_search.py uses it directly and
  // produces results that exactly match the Airbnb UI.
  const searchParams = {
    search_url: alert.search_url || null,

    // Fallback fields (used when there is no search_url)
    check_in:  alert.check_in  || null,
    check_out: alert.check_out || null,
    ne_lat:    alert.ne_lat    || null,
    ne_long:   alert.ne_long   || null,
    sw_lat:    alert.sw_lat    || null,
    sw_long:   alert.sw_long   || null,
    price_min: alert.price_min || null,
    price_max: alert.price_max || (urlParams && urlParams.price_max ? Number(urlParams.price_max) : null),
    guests:    alert.guests    || (urlParams && (parseInt(urlParams.adults || 0) + parseInt(urlParams.children || 0))) || 1,
    amenities: alert.amenities || (urlParams && (urlParams['amenities[]'] || urlParams.amenities)) || [],
    free_cancellation: alert.free_cancellation || false,
    currency:  (urlParams && urlParams.currency) || 'USD',
    proxy_url: process.env.PROXY_URL || '',

    // Extra filters forwarded to Python for the fallback search_all() path
    min_beds:    alert.min_beds    || (urlParams && urlParams.min_beds ? parseInt(urlParams.min_beds) : null) || null,
    infants:     alert.infants     || (urlParams && urlParams.infants  ? parseInt(urlParams.infants)  : null) || null,
    instant_book:  (urlParams && (urlParams.ib === 'true' || urlParams.instant_book === 'true')) || !!alert.instant_book || false,
    guest_favorite:(urlParams && urlParams.guest_favorite === 'true') || !!alert.guest_favorite || false,
    monthly_search: !!((urlParams && (urlParams.monthly_start_date || urlParams.monthly_length)) && !(alert.check_in && alert.check_out)),
  };

  // Run scraper
  let currentListings = [];
  try {
    currentListings = await searchFn(searchParams) || [];
  } catch (err) {
    logger.error(`Scraper failed for alert ${alertId}:`, err);
    return { status: 'error', error: err.message };
  }

  logger.info(`Alert ${alertId}: scraper returned ${currentListings.length} listings`);

  if (currentListings.length === 0) {
    logger.warn(`Alert ${alertId}: zero results — possible API change or filter mismatch`);
    await query(`UPDATE search_alerts SET last_checked = CURRENT_TIMESTAMP WHERE id = $1`, [alertId]);
    return { status: 'success', alertId, totalListings: 0, newListings: 0, priceDrops: 0, freedUp: 0 };
  }

  // ── Load what we already know about this alert ──────────────────────────────
  // known_listing_ids = listings we've seen before for this alert
  // We also load last known price per listing so we can detect drops.
  // Read last known price from price history (the only append-only source).
  // Using listings.price would give us the already-overwritten current value;
  // using search_results.old_price loses the original baseline on every upsert.
  // DISTINCT ON picks the single most-recent row per listing for this alert.
  const knownResult = await query(
    `SELECT DISTINCT ON (lph.listing_id)
            lph.listing_id,
            lph.price AS last_price
     FROM listing_price_history lph
     WHERE lph.search_alert_id = $1
     ORDER BY lph.listing_id, lph.recorded_at DESC`,
    [alertId]
  );
  const knownListings = new Map(knownResult.rows.map(r => [r.listing_id, Number(r.last_price)]));

  // ── Process each listing returned by the scraper ───────────────────────────
  const newListings       = [];
  const priceDropListings = [];
  const freedUpListings   = [];

  for (const listing of currentListings) {
    const id       = listing.id;
    const price    = extractPrice(listing.price);
    const url      = listingUrl(listing);

    if (!id) continue;

    // Upsert into listings cache
    await query(
      `INSERT INTO listings
         (listing_id, url, name, price, currency, rating, num_reviews,
          room_type, guests, beds, bedrooms, address, lat, lng,
          host_id, host_name, photos, last_updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,CURRENT_TIMESTAMP)
       ON CONFLICT (listing_id) DO UPDATE SET
         price      = EXCLUDED.price,
         rating     = EXCLUDED.rating,
         num_reviews= EXCLUDED.num_reviews,
         last_updated = CURRENT_TIMESTAMP`,
      [
        id, url, listing.name, price,
        listing.currency || 'USD',
        listing.rating,
        listing.reviewsCount || 0,
        listing.roomType,
        listing.guests,
        listing.beds,
        listing.bedrooms,
        listing.address,
        listing.lat,
        listing.lng,
        listing.hostId,
        listing.hostName,
        JSON.stringify(listing.photos || []),
      ]
    );

    // Append to price history only when price changes from last recorded value
    if (price != null) {
      await query(
        `INSERT INTO listing_price_history (listing_id, search_alert_id, price)
         SELECT $1, $2, $3
         WHERE NOT EXISTS (
           SELECT 1 FROM listing_price_history
           WHERE listing_id = $1 AND search_alert_id = $2
             AND price = $3
             AND recorded_at = (
               SELECT MAX(recorded_at) FROM listing_price_history
               WHERE listing_id = $1 AND search_alert_id = $2
             )
         )`,
        [id, alertId, price]
      );
    }

    const wasKnown   = knownListings.has(id);
    const lastPrice  = knownListings.get(id) ?? null;

    if (!wasKnown) {
      // ── NEW LISTING ──────────────────────────────────────────────────────
      // For date-specific searches, verify availability via iCal before
      // alerting — the search API returns all listings matching the filters
      // but doesn't guarantee the exact dates are open.
      if (alert.check_in && alert.check_out) {
        let available = false;
        try {
          available = await checkICalFn(id, alert.check_in, alert.check_out);
        } catch (err) {
          logger.warn(`iCal check failed for new listing ${id}: ${err.message}`);
          available = true; // optimistic — better to over-notify than miss
        }
        if (!available) {
          logger.debug(`New listing ${id} skipped — not available for requested dates`);
          // Still record it so we can track it for "freed up" later
          await upsertSearchResult(alertId, id, 'new', null, price);
          continue;
        }
      }

      await upsertSearchResult(alertId, id, 'new', null, price);
      newListings.push({ ...listing, price, url });

    } else {
      // ── EXISTING LISTING — check for price drop or freed-up ────────────

      // Price drop: current price is meaningfully lower than what we last stored.
      // Require a minimum absolute drop of $5 AND at least 3% to filter out
      // rounding noise and trivial Airbnb display fluctuations.
      const DROP_MIN_ABS = 5;   // dollars
      const DROP_MIN_PCT = 0.03; // 3%
      const drop = (price != null && lastPrice != null) ? lastPrice - price : 0;
      if (price != null && lastPrice != null && price < lastPrice &&
          drop >= DROP_MIN_ABS && drop / lastPrice >= DROP_MIN_PCT) {
        // Only alert if we haven't already notified at this price point
        const alreadyNotified = await query(
          `SELECT 1 FROM notifications
           WHERE search_alert_id = $1 AND listing_id = $2
             AND notification_type = 'price_drop'
             AND sent_at > NOW() - INTERVAL '24 hours'
           LIMIT 1`,
          [alertId, id]
        );
        if (alreadyNotified.rows.length === 0) {
          await upsertSearchResult(alertId, id, 'price_drop', lastPrice, price);
          // Fetch history to include in email
          const histResult = await query(
            `SELECT price, recorded_at FROM listing_price_history
             WHERE listing_id = $1 AND search_alert_id = $2
             ORDER BY recorded_at ASC`,
            [id, alertId]
          );
          priceDropListings.push({ ...listing, price, url, oldPrice: lastPrice, newPrice: price, priceHistory: histResult.rows });
        }
      }

      // Freed up: listing was previously unavailable for these dates but now is
      if (alert.check_in && alert.check_out) {
        try {
          const nowAvailable = await checkICalFn(id, alert.check_in, alert.check_out);
          if (nowAvailable) {
            // Only fire if we haven't sent a freed-up alert for this listing recently
            const alreadyNotified = await query(
              `SELECT 1 FROM notifications
               WHERE search_alert_id = $1 AND listing_id = $2
                 AND notification_type = 'availability_change'
                 AND sent_at > NOW() - INTERVAL '24 hours'
               LIMIT 1`,
              [alertId, id]
            );
            if (alreadyNotified.rows.length === 0) {
              await upsertSearchResult(alertId, id, 'freed_up', null, price);
              freedUpListings.push({ ...listing, price, url });
            }
          }
        } catch (err) {
          logger.warn(`iCal check failed for existing listing ${id}: ${err.message}`);
        }
      }
    }
  }

  // ── Mark last checked ──────────────────────────────────────────────────────
  await query(
    `UPDATE search_alerts SET last_checked = CURRENT_TIMESTAMP WHERE id = $1`,
    [alertId]
  );

  // ── Send emails ────────────────────────────────────────────────────────────
  const userResult = await query(
    `SELECT u.email, u.subscription_tier FROM users u
     JOIN search_alerts sa ON sa.user_id = u.id
     WHERE sa.id = $1`,
    [alertId]
  );
  const userEmail = userResult.rows[0]?.email;
  const subscriptionTier = userResult.rows[0]?.subscription_tier;

  if (userEmail) {
    // Premium tier: only email if new listings found (avoid email spam from hourly runs)
    // Basic tier: email for all changes (new, price drops, freed up) but max 1 email per 24 hours
    if (subscriptionTier === 'premium') {
      // Premium: only send if there are NEW listings
      await sendAlerts(userEmail, alert, alertId, newListings, 'new', 'new_listing', sendEmailFn);
    } else {
      // Basic: send all changes, but check if we've already sent an email in the last 24 hours
      const lastEmailCheck = await query(
        `SELECT last_notified FROM search_alerts WHERE id = $1`,
        [alertId]
      );
      
      const lastNotified = lastEmailCheck.rows[0]?.last_notified;
      const hasEmailedRecently = lastNotified && (new Date() - new Date(lastNotified)) < 24 * 60 * 60 * 1000;
      
      if (!hasEmailedRecently) {
        // Send email only if we haven't sent one in the last 24 hours
        const hasChanges = newListings.length > 0 || priceDropListings.length > 0 || freedUpListings.length > 0;
        
        if (hasChanges) {
          await sendAlerts(userEmail, alert, alertId, newListings,       'new',        'new_listing',       sendEmailFn);
          await sendAlerts(userEmail, alert, alertId, priceDropListings, 'price_drop', 'price_drop',        sendEmailFn);
          await sendAlerts(userEmail, alert, alertId, freedUpListings,   'availability','availability_change', sendEmailFn);
        }
      } else {
        logger.info(`Alert ${alertId} (basic tier): skipping email — sent one within last 24 hours`);
      }
    }
  }

  logger.info(
    `Alert ${alertId} done — new:${newListings.length} drops:${priceDropListings.length} freed:${freedUpListings.length}`
  );

  return {
    status: 'success',
    alertId,
    totalListings:  currentListings.length,
    newListings:    newListings.length,
    priceDrops:     priceDropListings.length,
    freedUp:        freedUpListings.length,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsertSearchResult(alertId, listingId, changeType, oldPrice, newPrice) {
  await query(
    `INSERT INTO search_results
       (search_alert_id, listing_id, change_type, old_price, new_price, detected_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
     ON CONFLICT (search_alert_id, listing_id) DO UPDATE SET
       change_type  = EXCLUDED.change_type,
       old_price    = EXCLUDED.old_price,
       new_price    = EXCLUDED.new_price,
       detected_at  = CURRENT_TIMESTAMP`,
    [alertId, listingId, changeType, oldPrice ?? null, newPrice ?? null]
  );
}

async function sendAlerts(userEmail, alert, alertId, listings, emailType, notifType, sendEmailFn) {
  if (!listings.length) return;
  try {
    await sendEmailFn(userEmail, alert, listings, { type: emailType });
    // Log each notification
    for (const l of listings) {
      await query(
        `INSERT INTO notifications
           (user_id, search_alert_id, listing_id, notification_type, email_sent)
         SELECT user_id, $1, $2, $3, true FROM search_alerts WHERE id = $1`,
        [alertId, l.id, notifType]
      );
    }
    await query(
      `UPDATE search_alerts SET
         last_notified      = CURRENT_TIMESTAMP,
         notification_count = notification_count + $2
       WHERE id = $1`,
      [alertId, listings.length]
    );
  } catch (err) {
    logger.error(`Failed to send ${emailType} email for alert ${alertId}:`, err);
    // Log failed notification
    for (const l of listings) {
      await query(
        `INSERT INTO notifications
           (user_id, search_alert_id, listing_id, notification_type, email_sent, email_error)
         SELECT user_id, $1, $2, $3, false, $4 FROM search_alerts WHERE id = $1`,
        [alertId, l.id, notifType, err.message]
      );
    }
  }
}

// ─── Wire up queue ────────────────────────────────────────────────────────────
scrapeQueue.process('search', async (job) => {
  return await runSearchAlert(job.data.alertId);
});

// ─── Listing-specific alert (iCal availability tracking) ─────────────────────
scrapeQueue.process('listing', async (job) => {
  const { alertId } = job.data;
  logger.info(`Processing listing alert ${alertId}`);

  const alertResult = await query(
    `SELECT * FROM search_alerts WHERE id = $1 AND is_active = true AND alert_type = 'listing'`,
    [alertId]
  );
  if (alertResult.rows.length === 0) {
    return { status: 'skipped', reason: 'Alert not found or inactive' };
  }
  const alert = alertResult.rows[0];

  let isAvailable = false;
  try {
    isAvailable = await checkICalAvailability(alert.listing_id, alert.check_in, alert.check_out);
  } catch (err) {
    logger.warn(`iCal check failed for listing alert ${alertId}: ${err.message}`);
  }

  if (isAvailable) {
    const alreadyNotified = await query(
      `SELECT 1 FROM notifications
       WHERE search_alert_id = $1 AND notification_type = 'availability_change'
         AND sent_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [alertId]
    );

    if (alreadyNotified.rows.length === 0) {
      const userResult = await query(`SELECT email FROM users WHERE id = $1`, [alert.user_id]);
      if (userResult.rows[0]) {
        await sendNewListingEmail(
          userResult.rows[0].email,
          alert,
          [{ url: alert.listing_url, id: alert.listing_id, name: 'Your tracked listing is now available!' }],
          { type: 'availability' }
        );
        await query(
          `INSERT INTO notifications (user_id, search_alert_id, listing_id, notification_type, email_sent)
           VALUES ($1, $2, $3, 'availability_change', true)`,
          [alert.user_id, alertId, alert.listing_id]
        );
        await query(
          `UPDATE search_alerts SET last_notified = CURRENT_TIMESTAMP, notification_count = notification_count + 1 WHERE id = $1`,
          [alertId]
        );
      }
    }
  }

  await query(`UPDATE search_alerts SET last_checked = CURRENT_TIMESTAMP WHERE id = $1`, [alertId]);
  return { status: 'success', alertId, isAvailable };
});

logger.info('🔄 Worker started');
export default scrapeQueue;
