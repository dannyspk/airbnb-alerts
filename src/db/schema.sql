-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  subscription_tier VARCHAR(20) DEFAULT 'basic' CHECK (subscription_tier IN ('basic', 'premium')),
  subscription_status VARCHAR(20) DEFAULT 'active' CHECK (subscription_status IN ('active', 'cancelled', 'expired')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Search alerts table
CREATE TABLE IF NOT EXISTS search_alerts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  alert_type VARCHAR(20) DEFAULT 'search' CHECK (alert_type IN ('search', 'listing')),
  
  -- For search-based alerts
  location VARCHAR(255),
  check_in DATE,
  check_out DATE,
  ne_lat DECIMAL(10, 8),
  ne_long DECIMAL(11, 8),
  sw_lat DECIMAL(10, 8),
  sw_long DECIMAL(11, 8),
  price_min INTEGER,
  price_max INTEGER,
  guests INTEGER,
  place_type VARCHAR(50),
  amenities JSONB,
  free_cancellation BOOLEAN DEFAULT FALSE,
  
  -- For specific listing alerts
  listing_id VARCHAR(100),
  listing_url TEXT,
  
  -- Metadata
  is_active BOOLEAN DEFAULT TRUE,
  last_checked TIMESTAMP,
  last_notified TIMESTAMP,
  notification_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Listings table (cache of discovered listings)
CREATE TABLE IF NOT EXISTS listings (
  id SERIAL PRIMARY KEY,
  listing_id VARCHAR(100) UNIQUE NOT NULL,
  url TEXT,
  name TEXT,
  price DECIMAL(10, 2),
  currency VARCHAR(10) DEFAULT 'USD',
  rating DECIMAL(3, 2),
  num_reviews INTEGER,
  room_type VARCHAR(100),
  guests INTEGER,
  bedrooms INTEGER,
  beds INTEGER,
  bathrooms DECIMAL(3, 1),
  address TEXT,
  lat DECIMAL(10, 8),
  lng DECIMAL(11, 8),
  amenities JSONB,
  host_id VARCHAR(100),
  host_name VARCHAR(255),
  photos JSONB,
  availability_hash VARCHAR(64),
  is_available BOOLEAN DEFAULT TRUE,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Search results (mapping between searches and listings)
CREATE TABLE IF NOT EXISTS search_results (
  id SERIAL PRIMARY KEY,
  search_alert_id INTEGER REFERENCES search_alerts(id) ON DELETE CASCADE,
  listing_id VARCHAR(100) REFERENCES listings(listing_id) ON DELETE CASCADE,
  detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  notification_sent BOOLEAN DEFAULT FALSE,
  change_type VARCHAR(20) CHECK (change_type IN ('new', 'freed_up', 'price_drop')),
  old_price DECIMAL(10, 2),
  new_price DECIMAL(10, 2)
);

-- Notifications log
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  search_alert_id INTEGER REFERENCES search_alerts(id) ON DELETE CASCADE,
  listing_id VARCHAR(100),
  notification_type VARCHAR(20) CHECK (notification_type IN ('new_listing', 'availability_change', 'price_drop')),
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  email_sent BOOLEAN DEFAULT FALSE,
  email_error TEXT
);

-- Add webhook delivery columns (safe to run repeatedly)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS webhook_sent BOOLEAN DEFAULT FALSE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS webhook_error TEXT;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_search_alerts_user_id ON search_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_search_alerts_active ON search_alerts(is_active);
CREATE INDEX IF NOT EXISTS idx_listings_listing_id ON listings(listing_id);
CREATE INDEX IF NOT EXISTS idx_listings_location ON listings(lat, lng);
CREATE INDEX IF NOT EXISTS idx_search_results_search_id ON search_results(search_alert_id);
CREATE INDEX IF NOT EXISTS idx_search_results_listing_id ON search_results(listing_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);

-- Refresh tokens (for JWT refresh flow)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash VARCHAR(128) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
