import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// Create transporter
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/**
 * Send new listing notification email
 */
export async function sendNewListingEmail(userEmail, alert, listings) {
  const listingCount = listings.length;
  const location = alert.location || 'your search area';
  
  const listingHTML = listings.slice(0, 5).map(listing => `
    <div style="border: 1px solid #ddd; padding: 15px; margin: 10px 0; border-radius: 8px;">
      <h3 style="margin: 0 0 10px 0;">${listing.name || 'New Listing'}</h3>
      ${listing.price ? `<p style="font-size: 18px; color: #008489; margin: 5px 0;"><strong>$${listing.price}</strong></p>` : ''}
      ${listing.rating ? `<p style="margin: 5px 0;">⭐ ${listing.rating} ${listing.reviewsCount ? `(${listing.reviewsCount} reviews)` : ''}</p>` : ''}
      ${listing.address ? `<p style="margin: 5px 0; color: #666;">${listing.address}</p>` : ''}
      <a href="${listing.url}" 
         style="display: inline-block; padding: 10px 20px; background: #FF5A5F; color: white; 
                text-decoration: none; border-radius: 4px; margin-top: 10px;">
        View on Airbnb
      </a>
    </div>
  `).join('');

  const mailOptions = {
    from: process.env.EMAIL_FROM,
    to: userEmail,
    subject: `${listingCount} New Airbnb Listing${listingCount > 1 ? 's' : ''} in ${location}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #FF5A5F; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f9f9f9; padding: 20px; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">🏠 New Airbnb Listings!</h1>
          </div>
          <div class="content">
            <p>Great news! We found <strong>${listingCount}</strong> new listing${listingCount > 1 ? 's' : ''} matching your search in ${location}:</p>
            
            <p><strong>Your search criteria:</strong></p>
            <ul>
              ${alert.check_in ? `<li>Check-in: ${new Date(alert.check_in).toLocaleDateString()}</li>` : ''}
              ${alert.check_out ? `<li>Check-out: ${new Date(alert.check_out).toLocaleDateString()}</li>` : ''}
              ${alert.price_min || alert.price_max ? `<li>Price: $${alert.price_min || 0} - $${alert.price_max || '∞'}</li>` : ''}
              ${alert.guests ? `<li>Guests: ${alert.guests}</li>` : ''}
            </ul>

            ${listingHTML}

            ${listingCount > 5 ? `<p style="text-align: center; margin-top: 20px;"><em>Showing 5 of ${listingCount} new listings</em></p>` : ''}
          </div>
          <div class="footer">
            <p>You're receiving this because you set up an alert for Airbnb listings.</p>
            <p><a href="${process.env.API_BASE_URL}/api/alerts">Manage your alerts</a></p>
          </div>
        </div>
      </body>
      </html>
    `
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Email error:', error);
    throw error;
  }
}

/**
 * Send welcome email
 */
export async function sendWelcomeEmail(userEmail) {
  const mailOptions = {
    from: process.env.EMAIL_FROM,
    to: userEmail,
    subject: 'Welcome to Airbnb Alerts!',
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #FF5A5F;">Welcome to Airbnb Alerts! 🎉</h1>
          <p>Thanks for signing up! You can now:</p>
          <ul>
            <li>Set up search alerts to find new listings</li>
            <li>Track specific listings for availability</li>
            <li>Get notified when prices drop</li>
          </ul>
          <p>Get started by creating your first alert!</p>
          <a href="${process.env.API_BASE_URL}" 
             style="display: inline-block; padding: 12px 24px; background: #FF5A5F; 
                    color: white; text-decoration: none; border-radius: 4px; margin-top: 10px;">
            Create Alert
          </a>
        </div>
      </body>
      </html>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('✅ Welcome email sent to:', userEmail);
  } catch (error) {
    console.error('❌ Welcome email error:', error);
  }
}

export default { sendNewListingEmail, sendWelcomeEmail };
