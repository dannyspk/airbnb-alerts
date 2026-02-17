import scrapeQueue from './queue.js';
import { query } from '../db/index.js';
import { searchAirbnb, getListingDetails } from './python-executor.js';
import { sendNewListingEmail } from '../services/email.js';
import { sendWebhook } from '../services/webhook.js';
import { checkICalAvailability } from '../services/ical.js';
import logger from '../utils/logger.js';

// Process search alerts
scrapeQueue.process('search', async (job) => {
  const { alertId } = job.data;
  
  try {
    logger.info(`Processing search alert ${alertId}`);

    // Get alert details
    const alertResult = await query(
      `SELECT * FROM search_alerts WHERE id = $1 AND is_active = true`,
      [alertId]
    );

    if (alertResult.rows.length === 0) {
      logger.warn(`Alert ${alertId} not found or inactive`);
      return { status: 'skipped', reason: 'Alert not found or inactive' };
    }

    const alert = alertResult.rows[0];

    // Prepare search parameters for Python scraper
    const searchParams = {
      check_in: alert.check_in,
      check_out: alert.check_out,
      ne_lat: alert.ne_lat,
      ne_long: alert.ne_long,
      sw_lat: alert.sw_lat,
      sw_long: alert.sw_long,
      price_min: alert.price_min,
      price_max: alert.price_max,
      guests: alert.guests || 1,
      place_type: alert.place_type || '',
      amenities: alert.amenities || [],
      free_cancellation: alert.free_cancellation || false,
      currency: 'USD',
      proxy_url: process.env.PROXY_URL || ''
    };

    // Run Python scraper
    const results = await searchAirbnb(searchParams);
    logger.info(`Found ${results.length} listings for alert ${alertId}`);

    // Get existing listings for this alert
    const existingResult = await query(
      `SELECT listing_id FROM search_results WHERE search_alert_id = $1`,
      [alertId]
    );
    const existingListingIds = new Set(existingResult.rows.map(r => r.listing_id));

    // Process each listing
    let newListings = [];
    for (const listing of results) {
      // Save or update listing
      await query(
        `INSERT INTO listings 
         (listing_id, url, name, price, currency, rating, num_reviews, 
          room_type, guests, address, lat, lng, host_id, host_name, photos, last_updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP)
         ON CONFLICT (listing_id) 
         DO UPDATE SET 
           price = EXCLUDED.price,
           rating = EXCLUDED.rating,
           num_reviews = EXCLUDED.num_reviews,
           last_updated = CURRENT_TIMESTAMP`,
        [
          listing.id,
          listing.url,
          listing.name,
          listing.price,
          listing.currency || 'USD',
          listing.rating,
          listing.reviewsCount || 0,
          listing.roomType,
          listing.guests,
          listing.address,
          listing.lat,
          listing.lng,
          listing.hostId,
          listing.hostName,
          JSON.stringify(listing.photos || [])
        ]
      );

      // Check if this is a new listing for this alert
      if (!existingListingIds.has(listing.id)) {
        await query(
          `INSERT INTO search_results 
           (search_alert_id, listing_id, change_type, new_price)
           VALUES ($1, $2, 'new', $3)`,
          [alertId, listing.id, listing.price]
        );
        newListings.push(listing);
      }
    }

    // Update alert last_checked timestamp
    await query(
      `UPDATE search_alerts SET last_checked = CURRENT_TIMESTAMP WHERE id = $1`,
      [alertId]
    );

    // Send notifications if there are new listings
    if (newListings.length > 0) {
      const userResult = await query(
        `SELECT u.email FROM users u 
         JOIN search_alerts sa ON sa.user_id = u.id 
         WHERE sa.id = $1`,
        [alertId]
      );

      if (userResult.rows.length > 0) {
        const userEmail = userResult.rows[0].email;

        // Send email as before
        await sendNewListingEmail(userEmail, alert, newListings);

        // For each new listing, optionally POST a webhook (if configured) and
        // then log the notification & webhook delivery status in DB.
        for (const listing of newListings) {
          let webhookSent = false;
          let webhookError = null;

          if (process.env.WEBHOOK_URL) {
            try {
              const payload = {
                event: 'new_listing',
                alert: { id: alert.id, type: alert.alert_type, location: alert.location, check_in: alert.check_in, check_out: alert.check_out },
                user: { id: alert.user_id, email: userEmail },
                listings: [listing],
                detected_at: new Date().toISOString()
              };

              const result = await sendWebhook({ url: process.env.WEBHOOK_URL, secret: process.env.WEBHOOK_SECRET, payload });
              webhookSent = !!result.ok;
              if (!result.ok) webhookError = result.error || 'webhook failed';
            } catch (err) {
              webhookSent = false;
              webhookError = String(err);
            }
          }

          // Log notification (email + optional webhook status)
          await query(
            `INSERT INTO notifications 
             (user_id, search_alert_id, listing_id, notification_type, email_sent, webhook_sent, webhook_error)
             SELECT user_id, $1, $2, 'new_listing', true, $3, $4 
             FROM search_alerts WHERE id = $1`,
            [alertId, listing.id, webhookSent, webhookError]
          );
        }

        await query(
          `UPDATE search_alerts 
           SET last_notified = CURRENT_TIMESTAMP, 
               notification_count = notification_count + $2
           WHERE id = $1`,
          [alertId, newListings.length]
        );
      }
    }

    return {
      status: 'success',
      alertId,
      totalListings: results.length,
      newListings: newListings.length
    };
  } catch (error) {
    logger.error(`Error processing alert ${alertId}:`, error);
    throw error;
  }
});

// Process listing-specific alerts (check availability via iCal)
scrapeQueue.process('listing', async (job) => {
  const { alertId } = job.data;

  try {
    logger.info(`Processing listing alert ${alertId}`);

    const alertResult = await query(
      `SELECT * FROM search_alerts WHERE id = $1 AND is_active = true AND alert_type = 'listing'`,
      [alertId]
    );

    if (alertResult.rows.length === 0) {
      return { status: 'skipped', reason: 'Alert not found or inactive' };
    }

    const alert = alertResult.rows[0];

    // Check availability via iCal
    const isAvailable = await checkICalAvailability(
      alert.listing_id,
      alert.check_in,
      alert.check_out
    );

    if (isAvailable) {
      // Get user email
      const userResult = await query(
        `SELECT email FROM users WHERE id = $1`,
        [alert.user_id]
      );

      if (userResult.rows.length > 0) {
        // Send notification
        const userEmail = userResult.rows[0].email;
        await sendNewListingEmail(userEmail, alert, [{ url: alert.listing_url, id: alert.listing_id, name: 'Listing now available!' }]);

        // optionally call webhook
        let webhookSent = false;
        let webhookError = null;
        if (process.env.WEBHOOK_URL) {
          try {
            const payload = {
              event: 'availability_change',
              alert: { id: alert.id, type: alert.alert_type, listing_id: alert.listing_id, check_in: alert.check_in, check_out: alert.check_out },
              user: { id: alert.user_id, email: userEmail },
              listings: [{ id: alert.listing_id, url: alert.listing_url }],
              detected_at: new Date().toISOString()
            };
            const result = await sendWebhook({ url: process.env.WEBHOOK_URL, secret: process.env.WEBHOOK_SECRET, payload });
            webhookSent = !!result.ok;
            if (!result.ok) webhookError = result.error || 'webhook failed';
          } catch (err) {
            webhookSent = false;
            webhookError = String(err);
          }
        }

        // Log notification with webhook status
        await query(
          `INSERT INTO notifications 
           (user_id, search_alert_id, listing_id, notification_type, email_sent, webhook_sent, webhook_error)
           VALUES ($1, $2, $3, 'availability_change', true, $4, $5)`,
          [alert.user_id, alertId, alert.listing_id, webhookSent, webhookError]
        );

        await query(
          `UPDATE search_alerts 
           SET last_notified = CURRENT_TIMESTAMP, 
               notification_count = notification_count + 1
           WHERE id = $1`,
          [alertId]
        );
      }
    }

    await query(
      `UPDATE search_alerts SET last_checked = CURRENT_TIMESTAMP WHERE id = $1`,
      [alertId]
    );

    return {
      status: 'success',
      alertId,
      isAvailable
    };
  } catch (error) {
    logger.error(`Error processing listing alert ${alertId}:`, error);
    throw error;
  }
});

logger.info('🔄 Worker started - processing jobs from queue');

export default scrapeQueue;
