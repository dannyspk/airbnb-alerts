const $ = (sel) => document.querySelector(sel);

function apiRequest(method, path, body) {
  const token = localStorage.getItem('token');
  return fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  }).then(async (res) => {
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;

    // Try transparent refresh once for expired access tokens
    if (res.status === 401 && json && (json.error === 'Invalid or expired token' || json.error === 'Access token required')) {
      try {
        const refreshRes = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
        const refreshJson = await refreshRes.json().catch(() => ({}));
        if (refreshRes.ok && refreshJson.token) {
          localStorage.setItem('token', refreshJson.token);
          const retryHeaders = Object.assign({}, { 'Content-Type': 'application/json' }, { Authorization: `Bearer ${refreshJson.token}` });
          const retry = await fetch(path, { method, headers: retryHeaders, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
          const retryJson = await retry.json().catch(() => ({}));
          if (retry.ok) return retryJson;
          throw retryJson;
        }
      } catch (err) {
        // fall through to original error
      }
    }

    throw json;
  });
}

function showMessage(msg, isError = false) {
  const el = $('#message');
  el.textContent = msg;
  el.className = `message ${isError ? 'error' : 'success'}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// Small helper to toggle a button's loading state (adds spinner + disables)
function setBtnLoading(btn, loading, tempText) {
  if (!btn) return;
  try {
    if (loading) {
      if (typeof tempText === 'string') {
        btn.dataset._orig = btn.innerHTML;
        btn.textContent = tempText;
      }
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
      if (btn.dataset._orig) { btn.innerHTML = btn.dataset._orig; delete btn.dataset._orig; }
    }
  } catch (e) { /* best-effort */ }
}

function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(atob(payload).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

async function refreshAccessTokenSilently() {
  try {
    const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.token) {
      localStorage.setItem('token', json.token);
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function handleLogout() {
  // notify server to revoke refresh token cookie
  apiRequest('POST', '/api/auth/logout').catch(() => {});
  localStorage.removeItem('token');
  showMessage('Logged out');
  // go back to auth page
  window.location.href = '/auth.html';
}

// ── Billing / subscription ───────────────────────────────────────────────────

let _currentSubscription = null; // cached so plan cards know what's active
let _selectedPlanKey = null;

const PLAN_DISPLAY = {
  basic_monthly:   { name: 'Basic',            price: '$4.99',  billing: '$4.99 billed every month',  desc: '1 search, 1 email a day with newly available listings' },
  premium_monthly: { name: 'Premium',           price: '$14.99', billing: '$14.99 billed every month', desc: '10 searches, email as soon as newly available listings detected' },
  premium_yearly:  { name: 'Premium — yearly',  price: '$89.99', billing: '$89.99 billed every year',  desc: '10 searches, email as soon as newly available listings detected', badge: '50% off' },
};

async function loadSubscription() {
  try {
    const res = await apiRequest('GET', '/api/billing/subscription');
    _currentSubscription = res;
    renderPlanSummary(res);
  } catch (err) {
    console.error('loadSubscription error', err);
    showMessage('Failed to load subscription', true);
  }
}

function renderPlanSummary(res) {
  const el = $('#plan-summary');
  if (!el) return;

  const sub  = res.subscription;
  const tier = sub?.plan || 'free';
  const status = sub?.status || 'none';

  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  const badgeClass = tier === 'premium' ? 'premium' : tier === 'basic' ? 'basic' : 'free';

  let detail = '';
  if (!sub || tier === 'free') {
    detail = 'No active subscription — upgrade to start monitoring listings.';
  } else if (status === 'past_due') {
    detail = '⚠️ Payment past due — please update your billing details.';
  } else if (status === 'canceled') {
    detail = 'Subscription cancelled.';
  } else {
    const periodEnd = sub.current_period_end
      ? new Date(sub.current_period_end).toLocaleDateString()
      : null;
    const interval = sub.interval === 'year' ? 'yearly' : 'monthly';
    detail = `${interval.charAt(0).toUpperCase() + interval.slice(1)} billing${periodEnd ? ` · renews ${periodEnd}` : ''}${sub.cancel_at_period_end ? ' · cancels at period end' : ''}`;
  }

  el.innerHTML = `<span class="tier-badge ${badgeClass}">${tierLabel}</span>${detail}`;
}

function renderPlanCards(currentPlanKey) {
  const container = $('#plan-cards');
  if (!container) return;
  container.innerHTML = '';
  _selectedPlanKey = null;
  $('#btn-confirm-upgrade').disabled = true;

  Object.entries(PLAN_DISPLAY).forEach(([key, plan]) => {
    const isCurrent = key === currentPlanKey;
    const card = document.createElement('div');
    card.className = 'plan-card' + (isCurrent ? ' selected' : '');
    card.dataset.key = key;
    card.innerHTML = `
      <div class="plan-card-header">
        <div class="plan-radio"><div class="plan-radio-dot"></div></div>
        <span class="plan-name">${plan.name}${plan.badge ? `<span class="plan-badge-yearly">${plan.badge}</span>` : ''}</span>
        <span class="plan-price">${plan.price}</span>
      </div>
      <div class="plan-card-billing">${plan.billing}</div>
      <div class="plan-card-desc">${plan.desc}</div>
    `;
    card.addEventListener('click', () => {
      if (isCurrent) return; // can't reselect current plan
      container.querySelectorAll('.plan-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      _selectedPlanKey = key;
      $('#btn-confirm-upgrade').disabled = false;
    });
    container.appendChild(card);
  });
}

async function handleUpgradeClick() {
  const panel = $('#upgrade-panel');
  panel.classList.remove('hidden');
  $('#btn-upgrade').classList.add('hidden');

  // Work out which plan key is currently active
  const sub = _currentSubscription?.subscription;
  let currentKey = null;
  if (sub?.plan && sub?.interval) {
    currentKey = sub.plan + '_' + sub.interval + 'ly'; // e.g. basic_monthly
    if (sub.interval === 'year') currentKey = sub.plan + '_yearly';
  }
  renderPlanCards(currentKey);
}

async function handleConfirmUpgrade() {
  if (!_selectedPlanKey) return;
  const btn = $('#btn-confirm-upgrade');
  setBtnLoading(btn, true, 'Redirecting…');
  try {
    const res = await apiRequest('POST', '/api/billing/checkout', { plan_key: _selectedPlanKey });
    if (res.url) window.location.href = res.url;
  } catch (err) {
    if (err.already_subscribed) {
      // Already subscribed — open portal to switch plans
      showMessage('Opening billing portal to switch plans…');
      await handleManageBilling();
    } else {
      showMessage(err.error || 'Failed to start checkout', true);
    }
  } finally {
    setBtnLoading(btn, false);
  }
}

async function handleManageBilling() {
  const btn = $('#btn-manage-billing');
  setBtnLoading(btn, true, 'Opening portal…');
  try {
    const res = await apiRequest('POST', '/api/billing/portal');
    if (res.url) window.location.href = res.url;
  } catch (err) {
    showMessage(err.error || 'Failed to open billing portal', true);
  } finally {
    setBtnLoading(btn, false);
  }
}

function init() {
  // Redirect to auth page if not signed in
  const token = localStorage.getItem('token');
  if (!token) return window.location.href = '/auth.html';

  // Wire up buttons
  $('#btn-logout').addEventListener('click', handleLogout);
  $('#btn-upgrade').addEventListener('click', handleUpgradeClick);
  $('#btn-manage-billing').addEventListener('click', handleManageBilling);
  $('#btn-confirm-upgrade').addEventListener('click', handleConfirmUpgrade);
  $('#btn-cancel-upgrade').addEventListener('click', () => {
    $('#upgrade-panel').classList.add('hidden');
    $('#btn-upgrade').classList.remove('hidden');
  });

  // Handle return from Stripe Checkout
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('checkout') === 'success') {
    showMessage('Payment successful — your plan is now active!');
    history.replaceState({}, '', '/billing.html');
  } else if (urlParams.get('checkout') === 'cancelled') {
    showMessage('Checkout cancelled — no charge was made.', true);
    history.replaceState({}, '', '/billing.html');
  }

  loadSubscription();
}

init();