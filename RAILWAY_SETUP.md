# Railway Deployment Setup

## Current Setup

Your app has **2 services** that need to run on Railway:

### 1. **Web Service** (Main App)
- Command: `node src/index.js`
- Purpose: API server + Scheduler (queues scraper jobs)
- Currently configured in `railway.json` ✅

### 2. **Worker Service** (Scraper)
- Command: `node src/workers/scraper-worker.js`
- Purpose: Processes scraper jobs from Redis queue
- **NOT yet configured** ⚠️

---

## How to Set Up Worker Service on Railway

### Step 1: Deploy Main Service (Already Done)
Your main web service is already configured via `railway.json`.

### Step 2: Add Worker Service

Follow these steps in your Railway dashboard:

#### Option A: Using Railway CLI (Faster)

```bash
# 1. Login to Railway
railway login

# 2. Link your project
railway link  # Select your existing project

# 3. Add worker service
railway service add
# Select: GitHub Repo (same repo)
# Set name: worker

# 4. Set environment variables
railway env
# Should automatically inherit from main service
# But verify it has: DATABASE_URL, REDIS_URL, etc.

# 5. Set the start command for worker
# Go to Railway Dashboard → worker service → Settings
# Start Command: node src/workers/scraper-worker.js
```

#### Option B: Using Railway Dashboard (Manual)

1. **Go to your Railway project**
2. **Click "New Service"** (top right)
3. **Select "GitHub Repo"** and choose your repo
4. **Name it**: `worker`
5. **Wait for it to build** (uses your Dockerfile)
6. **Click the service** → Settings
7. **Set Start Command**: `node src/workers/scraper-worker.js`
8. **Add Environment Variables**:
   - Copy all variables from main service:
     - `DATABASE_URL`
     - `REDIS_URL`
     - `DATABASE_REPLICA_URL` (if using)
     - `EMAIL_*` variables
     - Any other env vars used
9. **Click Deploy**

### Step 3: Verify Both Services Are Running

In your Railway dashboard:
```
┌─────────────────────────────────┐
│ Project: airbnb-alerts          │
├─────────────────────────────────┤
│ ✅ web (node src/index.js)      │
│    Status: Running              │
│    Port: 3000 (exposed)         │
│                                 │
│ ✅ worker (node src/workers...) │
│    Status: Running              │
│    Port: (none - background)    │
│                                 │
│ ✅ postgres (Railway DB)        │
│ ✅ redis (Railway Redis)        │
└─────────────────────────────────┘
```

---

## Verification

After setup, verify it's working:

### Check Logs

1. **Main Service Logs**:
   ```
   ✅ Scheduler started
   ✅ API listening on port 3000
   ```

2. **Worker Service Logs**:
   ```
   ✅ Worker listening to queue
   ✅ Processing jobs...
   ```

### Test It

```bash
# Check if scheduler is queueing jobs
# (logs should show "Queued X alerts")

# Check if worker is processing
# (logs should show "Processing search alert")
```

---

## Environment Variables Needed

Make sure both services have these variables set:

### Database
- `DATABASE_URL` - Primary Supabase DB
- `DATABASE_REPLICA_URL` - Railway read replica (optional)

### Redis (for job queue)
- `REDIS_URL` - Redis connection

### Email
- `EMAIL_SERVICE` - gmail (or other)
- `EMAIL_USER` - sender email
- `EMAIL_PASS` - email password/app password
- `EMAIL_FROM` - display name
- `API_BASE_URL` - your app URL (for email links)

### Optional
- `PROXY_URL` - if using proxy for scraping
- `NODE_ENV` - production

---

## What's Running Where

### **Web Service** (Main App)
```
Node process: node src/index.js
├── Express server (port 3000)
├── Database connection (PostgreSQL)
├── Redis connection
└── Scheduler (cron jobs)
    ├── 9 AM: Queue basic tier alerts
    ├── Every hour: Queue premium tier alerts
    ├── 3 AM: Cleanup old notifications
    └── 2 AM Sunday: Cleanup old results
```

### **Worker Service** (Background)
```
Node process: node src/workers/scraper-worker.js
├── Redis queue listener
├── Process each job
│   ├── Search Airbnb
│   ├── Compare with previous results
│   ├── Detect new/price drops/availability
│   └── Send emails
└── Log results
```

Both services share:
- Same PostgreSQL database
- Same Redis queue
- Same email configuration

---

## Troubleshooting

### Worker Not Processing Jobs

1. **Check worker is running**:
   - Railway dashboard → worker service
   - Status should be "Running"

2. **Check Redis connection**:
   - Verify `REDIS_URL` is set on worker service
   - Try accessing Redis from worker logs

3. **Check logs**:
   - Look for connection errors
   - Look for job processing logs

### Jobs Queuing But Not Processing

1. **Verify worker has same REDIS_URL**
2. **Check worker logs for errors**
3. **Restart worker service**: Railway dashboard → service → Restart

### Emails Not Sending

1. **Check EMAIL_* variables on worker service**
2. **Check worker logs for email errors**
3. **Verify SMTP credentials are correct**

---

## Quick Checklist

- [ ] Main service deployed and running
- [ ] Worker service created
- [ ] Worker start command set: `node src/workers/scraper-worker.js`
- [ ] Environment variables copied to worker
- [ ] Both services showing "Running" status
- [ ] Logs show scheduler queuing jobs
- [ ] Logs show worker processing jobs
- [ ] Test alert created
- [ ] Email received when new listing found

---

## Next Steps

1. **Create worker service** on Railway (following steps above)
2. **Verify both services are running**
3. **Monitor logs** for 24 hours
4. **Test** by creating a test alert
5. **Adjust** if needed (frequency, email settings, etc.)

Once both services are running, everything happens automatically! 🚀
