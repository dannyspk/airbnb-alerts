import axios from 'axios';
import crypto from 'crypto';

// Send a JSON webhook with optional HMAC signing and simple retry/backoff.
// params: { url, secret, payload, maxAttempts = 3 }
export async function sendWebhook({ url, secret, payload, maxAttempts = 3 }) {
  if (!url) return { ok: false, error: 'no-url' };
  const body = JSON.stringify(payload || {});
  const signature = secret ? `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}` : undefined;

  let attempt = 0;
  let lastErr = null;
  while (attempt < maxAttempts) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-Hook-Timestamp': new Date().toISOString()
      };
      if (signature) headers['X-Signature'] = signature;

      const res = await axios.post(url, body, { headers, timeout: 10000 });
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, status: res.status, data: res.data };
      }
      lastErr = new Error(`non-2xx status: ${res.status}`);
    } catch (err) {
      lastErr = err;
      // exponential backoff (small, worker will retry jobs separately if needed)
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 250));
    }
    attempt++;
  }

  return { ok: false, error: lastErr ? String(lastErr) : 'unknown' };
}

export default { sendWebhook };