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
          // ensure we proactively schedule the next refresh
          try { scheduleTokenRefresh(); } catch (e) { /* ignore */ }
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

// --- silent refresh helpers ---------------------------------
let _refreshTimer = null;

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
      scheduleTokenRefresh();
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function scheduleTokenRefresh() {
  if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
  const token = localStorage.getItem('token');
  if (!token) return;
  const payload = decodeJwt(token);
  if (!payload || !payload.exp) return;
  const expiresAt = payload.exp * 1000; // exp is in seconds
  const msUntilExpiry = expiresAt - Date.now();
  // refresh 60s before expiry, but at least after 5s
  const refreshIn = Math.max(5000, msUntilExpiry - 60 * 1000);
  if (refreshIn <= 0) {
    // token is already expired or about to — try immediate refresh
    refreshAccessTokenSilently().then(ok => { if (!ok) { /* let apiRequest handle logout on next call */ } });
    return;
  }
  _refreshTimer = setTimeout(async () => {
    const ok = await refreshAccessTokenSilently();
    if (!ok) {
      // if refresh failed, clear token and navigate to auth (user will see login page)
      localStorage.removeItem('token');
      showMessage('Session expired — please sign in again', true);
      window.location.href = '/auth.html';
    }
  }, refreshIn);
}

async function handleRegister() {
  try {
    const email = $('#email').value.trim().toLowerCase();
    const password = $('#password').value;
    const res = await apiRequest('POST', '/api/auth/register', { email, password });
    localStorage.setItem('token', res.token);
  try { scheduleTokenRefresh(); } catch (e) { /* ignore */ }
    showLoggedInState();
    showMessage('Registered and logged in');
  } catch (err) {
    showMessage(err.error || JSON.stringify(err), true);
  }
}

async function handleLogin() {
  try {
    const email = $('#email').value.trim().toLowerCase();
    const password = $('#password').value;
    const res = await apiRequest('POST', '/api/auth/login', { email, password });
    localStorage.setItem('token', res.token);
  try { scheduleTokenRefresh(); } catch (e) { /* ignore */ }
    showLoggedInState();
    showMessage('Logged in');
  } catch (err) {
    showMessage(err.error || JSON.stringify(err), true);
  }
}

function handleLogout() {
  // notify server to revoke refresh token cookie
  apiRequest('POST', '/api/auth/logout').catch(() => {});
  localStorage.removeItem('token');
  if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
  // Clear locally persisted preview state on logout for privacy
  localStorage.removeItem('lastPreview');
  document.getElementById('btn-logout').classList.add('hidden');
  document.getElementById('create-alert-card').classList.add('hidden');
  document.getElementById('alerts-card').classList.add('hidden');
  showMessage('Logged out');
  // go back to auth page
  window.location.href = '/auth.html';
}

async function createUrlAlert() {
  const btn = $('#btn-create-url-alert');
  setBtnLoading(btn, true, 'Saving...');
  try {
    const search_url = $('#alert-search-url').value.trim();
    if (!search_url) return showMessage('Please paste an Airbnb search URL', true);
    if (!search_url.includes('airbnb.com')) return showMessage('URL must be from airbnb.com', true);
    const res = await apiRequest('POST', '/api/alerts/url', { search_url });
    showMessage(res.message || 'Alert saved!');
    $('#alert-search-url').value = '';
    loadAlerts();
  } catch (err) {
    if (err.upgrade_required) {
      showMessage(err.error, true);
      // Scroll to subscription card and pop open the upgrade picker
      document.getElementById('subscription-card')?.scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => handleUpgradeClick(), 400);
    } else {
      showMessage(err.error || JSON.stringify(err), true);
    }
  } finally {
    setBtnLoading(btn, false);
  }
}

async function createListingAlert() {
  const btn = $('#btn-save-listing');
  setBtnLoading(btn, true, 'Saving...');
  try {
    const listing_id = $('#listing-id').value;
    const listing_url = $('#listing-url').value;
    const check_in = $('#check-in').value || null;
    const check_out = $('#check-out').value || null;
    const res = await apiRequest('POST', '/api/alerts/listing', { listing_id, listing_url, check_in, check_out });
    showMessage('Listing alert saved');
    loadAlerts();
  } catch (err) {
    showMessage(err.error || JSON.stringify(err), true);
  } finally {
    setBtnLoading(btn, false);
  }
}

function renderAlerts(alerts) {
  const container = $('#alerts-list');
  if (!alerts || alerts.length === 0) {
    container.innerHTML = '<i>No alerts yet</i>';
    return;
  }

  container.innerHTML = '';
  alerts.forEach((a) => {
    const div = document.createElement('div');
    div.className = 'alert-item';
    div.innerHTML = `
        <div class="meta">
          <strong>${a.alert_type.toUpperCase()}</strong>
          <span>#${a.id}</span>
        </div>
        <div>${a.search_url ? (a.location || 'Search alert') : (a.listing_url || a.location || '')}</div>
        <div class="controls">
          ${a.alert_type === 'search' ? `<button data-id="${a.id}" class="btn-run">Run now</button><button data-id="${a.id}" class="btn-view-listings">View listings</button>` : ''}
          <button data-id="${a.id}" class="btn-toggle">${a.is_active ? 'Deactivate' : 'Activate'}</button>
          <button data-id="${a.id}" class="btn-delete">Delete</button>
        </div>
      `;
    container.appendChild(div);
  });

  document.querySelectorAll('.btn-toggle').forEach((btn) => {
    btn.onclick = async (e) => {
      const id = e.target.dataset.id;
      const alert = alerts.find(x => x.id == id);
      try {
        await apiRequest('PUT', `/api/alerts/${id}`, { is_active: !alert.is_active });
        showMessage('Alert updated');
        loadAlerts();
      } catch (err) {
        showMessage(err.error || JSON.stringify(err), true);
      }
    };
  });

  document.querySelectorAll('.btn-delete').forEach((btn) => {
    btn.onclick = async (e) => {
      const id = e.target.dataset.id;
      try {
        await apiRequest('DELETE', `/api/alerts/${id}`);
        showMessage('Alert deleted');
        loadAlerts();
      } catch (err) {
        showMessage(err.error || JSON.stringify(err), true);
      }
    };
  });

  // Run now / View listings for search alerts
  document.querySelectorAll('.btn-run').forEach((btn) => {
    btn.onclick = async (e) => {
      const id = e.target.dataset.id;
      try {
        await apiRequest('POST', `/api/alerts/${id}/run`);
        showMessage('Queued job — results will appear shortly');
      } catch (err) {
        showMessage(err.error || JSON.stringify(err), true);
      }
    };
  });

  document.querySelectorAll('.btn-view-listings').forEach((btn) => {
    btn.onclick = async (e) => {
      const id = e.target.dataset.id;
      viewListingsForAlert(id);
    };
  });
}

async function createSearchAlert() {
  const btn = $('#btn-create-search');
  setBtnLoading(btn, true, 'Creating...');
  try {
    const location = $('#search-location').value;
    const check_in = $('#search-check-in').value;
    const check_out = $('#search-check-out').value;
    const price_min = $('#price-min').value ? parseInt($('#price-min').value, 10) : null;
    const price_max = $('#price-max').value ? parseInt($('#price-max').value, 10) : null;
    const guests = $('#guests').value ? parseInt($('#guests').value, 10) : 1;

    if (!location || !check_in || !check_out) {
      return showMessage('Location and dates are required', true);
    }

    await apiRequest('POST', '/api/alerts/search', { location, check_in, check_out, price_min, price_max, guests });
    showMessage('Search alert created');
    loadAlerts();
  } catch (err) {
    showMessage(err.error || JSON.stringify(err), true);
  } finally {
    setBtnLoading(btn, false);
  }
}

async function viewListingsForAlert(alertId) {
  try {
    $('#listings-for-id').textContent = alertId;
    const res = await apiRequest('GET', `/api/listings/alert/${alertId}`);
    renderListings(res.listings || []);
    document.getElementById('listings-panel').classList.remove('hidden');
  } catch (err) {
    showMessage(err.error || JSON.stringify(err), true);
  }
}

// --- DB-backed listings (alerts) ---
function renderListings(listings) {
  const container = $('#listings-list');
  if (!listings || listings.length === 0) {
    container.innerHTML = '<i>No listings yet — try "Run now" or wait a few seconds</i>';
    return;
  }

  container.innerHTML = '';
  const total = listings.length || 0;
  const header = document.createElement('div');
  header.style.marginBottom = '8px';
  header.style.color = 'rgba(255,255,255,0.6)';
  header.textContent = `Showing ${Math.min(total, 50)} of ${total} listings`;
  container.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'listing-grid';
  container.appendChild(grid);

  listings.slice(0, 50).forEach((l) => {
    const id = l.listing_id || l.listingid || l.id || '';
    const card = document.createElement('div');
    card.className = 'listing-card';
    const photoUrl = (l.photos && l.photos.length) ? (l.photos[0].url || l.photos[0]) : '';
    const listingUrl = l.url || (id ? `https://www.airbnb.com/rooms/${id}` : '');
    card.innerHTML = `
      <div class="listing-thumb">
        ${photoUrl ? `${listingUrl ? `<a href="${listingUrl}" target="_blank" rel="noopener noreferrer" aria-label="Open listing in Airbnb">` : ''}<img src="${photoUrl}" loading="lazy" alt="${(l.name||'listing').replace(/"/g,'')}">${listingUrl ? `</a>` : ''}` : ''}
        <div class="price-badge">${l.price ? (typeof l.price === 'object' ? ('$' + (l.price.unit?.amount || l.price.amount || '')) : ('$' + l.price)) : ''}</div>
      </div>
      <div class="listing-meta">
        <div class="listing-title">${l.name || '—'}</div>
        <div class="listing-sub">${(l.address || '').substring(0, 120)}</div>
        <div style="margin-top:8px">
          <span class="rating">⭐ ${l.rating ? (l.rating.guest_satisfaction || l.rating) : '—'}</span>
        </div>
        <div class="listing-actions">
          <button data-id="${id}" class="btn-save-listing-inline" ${(!id || id === 'None') ? 'disabled' : ''}>Save listing</button>
          <button data-id="${id}" class="btn-open-details">Details</button>
          <button data-url="${l.url || ''}" class="btn-share">Share</button>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });

  // inline save requires confirmation
  document.querySelectorAll('.btn-save-listing-inline').forEach((btn) => {
    btn.onclick = async (e) => {
      const listingId = e.target.dataset.id;
      const confirmed = await confirmAction('Save this listing as an alert?');
      if (!confirmed) return;
      const listing = listings.find(x => (x.id || x.listing_id || x.listingId) == listingId) || {};
      const b = e.target;
      setBtnLoading(b, true, 'Saving...');
      try {
        await apiRequest('POST', '/api/alerts/listing', { listing_id: listingId, listing_url: listing.url || '' });
        showMessage('Listing saved as alert');
        loadAlerts();
      } catch (err) {
        showMessage(err.error || JSON.stringify(err), true);
      } finally {
        setBtnLoading(b, false);
      }
    };
  });

  document.querySelectorAll('.btn-open-details').forEach((btn) => {
    btn.onclick = async (e) => {
      const listingId = e.target.dataset.id;
      showListingModal(listingId);
    };
  });

  document.querySelectorAll('.btn-share').forEach((btn) => {
    btn.onclick = (e) => {
      const url = e.target.dataset.url;
      if (!url) return showMessage('No shareable URL for this listing', true);
      navigator.clipboard?.writeText(url).then(() => showMessage('Listing URL copied to clipboard'))
        .catch(() => showMessage('Could not copy URL', true));
    };
  });
}

// --- Preview results (server-side pagination) ---
let previewState = { params: null, page: 1, pageSize: 20, total: 0, results: [] };
// set when the user picks a location from the autocomplete suggestions
let selectedLocation = null;

// Persist last preview search so the dashboard can restore it after a refresh.
function savePreviewToLocalStorage() {
  if (!previewState || !previewState.params) return;
  try {
    const payload = {
      params: previewState.params,
      page: previewState.page || 1,
      pageSize: previewState.pageSize || 20,
      selectedLocation: selectedLocation ? { display_name: selectedLocation.display_name, boundingbox: selectedLocation.boundingbox } : null,
      savedAt: Date.now()
    };
    localStorage.setItem('lastPreview', JSON.stringify(payload));
  } catch (e) { /* ignore */ }
}

function loadPreviewFromLocalStorage() {
  // Preview state restoration is only relevant if the search panel exists
  if (!$('#page-size')) return null;
  try {
    const raw = localStorage.getItem('lastPreview');
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || !saved.params) return null;
    previewState.params    = saved.params;
    previewState.page      = saved.page || 1;
    previewState.pageSize  = saved.pageSize || previewState.pageSize;
    const ps = $('#page-size'); if (ps) ps.value = previewState.pageSize;
    return saved;
  } catch (e) { return null; }
}

// Client-side location autocomplete (Nominatim). Keeps a small in-memory
// suggestions box and exposes the chosen result via `selectedLocation`.
function initLocationAutocomplete() {
  const input = $('#search-location');
  const suggBox = $('#location-suggestions');
  if (!input || !suggBox) return;

  let debounceTimer = null;
  let currentResults = [];
  let highlighted = -1;

  input.addEventListener('input', () => {
    selectedLocation = null; // clear previous selection when typing
    const q = input.value.trim();
    if (!q || q.length < 2) { suggBox.classList.add('hidden'); suggBox.innerHTML = ''; return; }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=0&limit=6`;
        const res = await fetch(url);
        const arr = await res.json().catch(() => []);
        currentResults = Array.isArray(arr) ? arr : [];

        if (!currentResults.length) {
          suggBox.innerHTML = '<div class="note" style="padding:8px">No results</div>';
          suggBox.classList.remove('hidden');
          return;
        }

        suggBox.innerHTML = currentResults.map((it, i) => `<div class="suggestion-item" data-idx="${i}">${it.display_name}</div>`).join('');
        suggBox.classList.remove('hidden');
        highlighted = -1;
      } catch (err) {
        console.error('location autocomplete error', err);
        suggBox.classList.add('hidden');
      }
    }, 300);
  });

  // keyboard navigation inside suggestions
  input.addEventListener('keydown', (ev) => {
    const items = Array.from(suggBox.querySelectorAll('.suggestion-item'));
    if (!items.length) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault(); highlighted = Math.min(items.length - 1, highlighted + 1);
      items.forEach(i => i.classList.remove('highlight'));
      items[highlighted].classList.add('highlight');
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault(); highlighted = Math.max(0, highlighted - 1);
      items.forEach(i => i.classList.remove('highlight'));
      items[highlighted].classList.add('highlight');
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const idx = highlighted >= 0 ? highlighted : 0;
      const item = items[idx];
      if (item) item.click();
    } else if (ev.key === 'Escape') {
      suggBox.classList.add('hidden');
    }
  });

  // click/select a suggestion
  suggBox.addEventListener('click', (ev) => {
    const item = ev.target.closest('.suggestion-item');
    if (!item) return;
    const idx = parseInt(item.dataset.idx, 10);
    const sel = currentResults[idx];
    if (!sel) return;
    // short display in input, keep full result in selectedLocation
    input.value = sel.display_name.split(',').slice(0, 3).join(', ');
    selectedLocation = sel;
    suggBox.classList.add('hidden');
  });

  // hide when clicking elsewhere
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('#location-suggestions') && ev.target !== input) {
      suggBox.classList.add('hidden');
    }
  });
}

async function fetchPreviewPage(page = 1) {
  if (!previewState.params) return;
  previewState.page = Math.max(1, page);
  previewState.pageSize = parseInt($('#page-size').value, 10) || previewState.pageSize;

  const container = $('#listings-list');
  // skeleton while fetching (grid)
  container.innerHTML = '';
  const skGrid = document.createElement('div');
  skGrid.className = 'listing-grid';
  const skeletonCount = Math.min(8, previewState.pageSize || 6);
  for (let i = 0; i < skeletonCount; i++) {
    const sk = document.createElement('div');
    sk.className = 'listing-card skeleton-card';
    sk.innerHTML = `<div class="skeleton skeleton-thumb"></div><div style="flex:1"><div class="skeleton-line" style="width:60%"></div><div class="skeleton-line" style="width:40%"></div></div>`;
    skGrid.appendChild(sk);
  }
  container.appendChild(skGrid);

  try {
    const body = Object.assign({}, previewState.params, { page: previewState.page, pageSize: previewState.pageSize });
    const res = await apiRequest('POST', '/api/listings/search', body);
    const results = res.results || [];
    previewState.results = results;
    previewState.total = res.total || results.length || 0;
    renderPreviewResults(results, previewState.total);
    // persist the last preview (params + page) so reload restores it
    try { savePreviewToLocalStorage(); } catch (e) { /* ignore */ }
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger)">Search failed: ${err.error || err.message || JSON.stringify(err)}</div>`;
  }
}

function renderPreviewResults(results, total) {
  const container = $('#listings-list');
  if (!results || results.length === 0) {
    container.innerHTML = '<i>No results — try a different date or location</i>';
    previewState.results = [];
    previewState.total = total || 0;
    $('#btn-prev-page').disabled = true;
    $('#btn-next-page').disabled = true;
    return;
  }

  container.innerHTML = '';
  const start = (previewState.page - 1) * previewState.pageSize;
  const end = Math.min(previewState.total, start + results.length);

  const header = document.createElement('div');
  header.style.marginBottom = '8px';
  header.style.color = 'var(--muted)';
  header.textContent = `Showing ${start + 1}–${end} of ${previewState.total} results`;
  container.appendChild(header);

  // results grid
  const grid = document.createElement('div');
  grid.className = 'listing-grid';
  container.appendChild(grid);

  // debug output (visible during development) — raw API response
  try {
    const dbg = $('#preview-debug');
    // only show debug JSON when explicitly enabled in the browser (localStorage.debug === '1')
    if (dbg) {
      if (localStorage.getItem('debug') === '1') {
        dbg.textContent = JSON.stringify({ total, page: previewState.page, pageSize: previewState.pageSize, resultsCount: results.length }, null, 2);
        dbg.classList.remove('hidden');
      } else {
        dbg.classList.add('hidden');
      }
    }
  } catch (e) { /* ignore */ }

  results.forEach((l) => {
    const id = l.id || l.listing_id || '';
  const photoUrl = (l.photos && l.photos.length) ? (l.photos[0].url || l.photos[0]) : '';
  // compute badges (server already added isSaved/isSuperhost/_priceAmount/_reviewsCount)
    const badges = [];
    if (l.isSaved) badges.push('<span class="badge saved">Saved</span>');
    if (l.isSuperhost) badges.push('<span class="badge superhost">Superhost</span>');
    // popularity/premium heuristics (also can be set server-side via filters)
    const priceAmt = l._priceAmount || (l.price && (l.price.unit?.amount || l.price.amount || (l.price.total && l.price.total.amount))) || 0;
    const reviews = l._reviewsCount || 0;
    const ratingVal = l._ratingValue || (l.rating && l.rating.value) || 0;
    if (priceAmt >= (previewState.params?.premium_min_price || previewState.params?.min_price || 200)) badges.push('<span class="badge premium">Premium</span>');
    if (reviews >= (previewState.params?.popular_min_reviews || 50) || (ratingVal >= (previewState.params?.popular_min_rating || 4.7) && reviews >= 10)) badges.push('<span class="badge popular">Popular</span>');

    const listingUrl = l.url || (id ? `https://www.airbnb.com/rooms/${id}` : '');
    const card = document.createElement('div');
    card.className = 'listing-card';
    card.innerHTML = `
      <div class="listing-thumb">
        ${photoUrl ? `${listingUrl ? `<a href="${listingUrl}" target="_blank" rel="noopener noreferrer" aria-label="Open listing in Airbnb">` : ''}<img src="${photoUrl}" loading="lazy" alt="${(l.name||'listing').replace(/"/g,'')}">${listingUrl ? `</a>` : ''}` : ''}
        <div class="price-badge">${l.price ? (typeof l.price === 'object' ? ('$' + (l.price.unit?.amount || l.price.amount || '')) : ('$' + l.price)) : ''}</div>
      </div>
      <div class="listing-meta">
        <div style="display:flex;gap:8px;align-items:center">
          <div class="listing-title">${l.name || '—'}</div>
          <div>${badges.join('')}</div>
        </div>
        <div class="listing-sub">${(l.address || l.url || '').substring(0, 120)}</div>
        <div style="margin-top:8px">
          <span class="rating">⭐ ${l.rating ? (l.rating.guest_satisfaction || l.rating.value || l.rating) : '—'}</span>
        </div>
        <div class="listing-actions">
          <button data-id="${id}" class="btn-save-listing-inline" ${(!id || id === 'None' || l.isSaved) ? 'disabled' : ''}>${l.isSaved ? 'Saved' : 'Save listing'}</button>
          <button data-id="${id}" class="btn-open-details">Details</button>
          <button data-url="${l.url || ''}" class="btn-share">Share</button>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });

  // wire up buttons
  document.querySelectorAll('.btn-save-listing-inline').forEach((btn) => {
    btn.onclick = async (e) => {
      const listingId = e.target.dataset.id;
      const confirmed = await confirmAction('Save this listing as an alert?');
      if (!confirmed) return;
      const listing = previewState.results.find(x => (x.id || x.listing_id || x.listingId) == listingId) || {};
      const b = e.target;
      setBtnLoading(b, true, 'Saving...');
      try {
        await apiRequest('POST', '/api/alerts/listing', { listing_id: listingId, listing_url: listing.url || '' });
        showMessage('Listing saved as alert');
        loadAlerts();
      } catch (err) {
        showMessage(err.error || JSON.stringify(err), true);
      } finally {
        setBtnLoading(b, false);
      }
    };
  });

  document.querySelectorAll('.btn-open-details').forEach((btn) => {
    btn.onclick = (e) => showListingModal(e.target.dataset.id);
  });

  document.querySelectorAll('.btn-share').forEach((btn) => {
    btn.onclick = (e) => {
      const url = e.target.dataset.url;
      if (!url) return showMessage('No shareable URL for this listing', true);
      navigator.clipboard?.writeText(url).then(() => showMessage('Listing URL copied to clipboard'))
        .catch(() => showMessage('Could not copy URL', true));
    };
  });

  // pagination control state
  const maxPage = Math.ceil((previewState.total || 0) / previewState.pageSize) || 1;
  $('#btn-prev-page').disabled = previewState.page <= 1;
  $('#btn-next-page').disabled = previewState.page >= maxPage;
}

async function loadNotifications() {
  try {
    const res = await apiRequest('GET', '/api/listings/notifications/recent');
    const container = $('#notifications-list');
    if (!res.notifications || res.notifications.length === 0) {
      container.innerHTML = '<i>No notifications yet</i>';
      return;
    }
    container.innerHTML = res.notifications.map(n => `
      <div class="alert-item">
        <div><strong>${n.notification_type}</strong> — ${n.listing_name || n.listing_id || ''}</div>
        <div style="color:rgba(255,255,255,0.6)">${new Date(n.sent_at).toLocaleString()}</div>
      </div>
    `).join('');
  } catch (err) {
    console.error(err);
  }
}

async function loadAlerts() {
  try {
    const res = await apiRequest('GET', '/api/alerts');
    renderAlerts(res.alerts || []);
    document.getElementById('alerts-card').classList.remove('hidden');
  } catch (err) {
    showMessage('Failed to load alerts — are you logged in?', true);
  }
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
    document.getElementById('subscription-card').classList.remove('hidden');

    // Show/hide create-alert card based on whether they have an active paid plan
    const canCreate = canCreateAlerts(res);
    document.getElementById('create-alert-card').classList.toggle('hidden', !canCreate);

    // Show/hide upgrade button — hide if already on premium
    const tier = res.subscription?.plan || 'free';
    const isPremium = tier === 'premium' && ['active','trialing'].includes(res.subscription?.status);
    $('#btn-upgrade').classList.toggle('hidden', isPremium);
  } catch (err) {
    console.error('loadSubscription error', err);
  }
}

function canCreateAlerts(subData) {
  if (!subData) return false;
  const status = subData.subscription?.status;
  const plan   = subData.subscription?.plan;
  // Must have an active/trialing paid subscription
  return ['active', 'trialing'].includes(status) && plan && plan !== 'free';
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

function showLoggedInState() {
  document.getElementById('btn-logout').classList.remove('hidden');
  loadSubscription();
  loadAlerts();
  // Reveal alerts card always — loadAlerts fills it
  document.getElementById('alerts-card').classList.remove('hidden');
  document.getElementById('notifications-card').classList.remove('hidden');
}

function init() {
  // Redirect to auth page if not signed in
  const token = localStorage.getItem('token');
  if (!token) return window.location.href = '/auth.html';

  // Schedule silent refresh for the existing token
  try { scheduleTokenRefresh(); } catch (e) { /* ignore */ }

  // Wire up buttons that exist in the DOM
  const safeOn = (sel, handler) => { const el = $(sel); if (el) el.addEventListener('click', handler); };
  const safeKey = (sel, handler) => { const el = $(sel); if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') handler(); }); };

  safeOn('#btn-logout',           handleLogout);
  safeOn('#btn-save-listing',     createListingAlert);
  safeOn('#btn-create-url-alert', createUrlAlert);
  safeOn('#btn-refresh',          loadAlerts);
  safeKey('#alert-search-url',    createUrlAlert);

  // Billing
  safeOn('#btn-upgrade',          handleUpgradeClick);
  safeOn('#btn-manage-billing',   handleManageBilling);
  safeOn('#btn-confirm-upgrade',  handleConfirmUpgrade);
  safeOn('#btn-cancel-upgrade',   () => {
    $('#upgrade-panel').classList.add('hidden');
    $('#btn-upgrade').classList.remove('hidden');
  });

  // Handle return from Stripe Checkout
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('checkout') === 'success') {
    showMessage('Payment successful — your plan is now active!');
    history.replaceState({}, '', '/');
  } else if (urlParams.get('checkout') === 'cancelled') {
    showMessage('Checkout cancelled — no charge was made.', true);
    history.replaceState({}, '', '/');
  }

  // Pagination controls (only wire if elements exist)
  const pageSizeEl = $('#page-size');
  if (pageSizeEl) pageSizeEl.onchange = (e) => {
    previewState.pageSize = parseInt(e.target.value, 10) || 20;
    fetchPreviewPage(previewState.page);
  };

  safeOn('#btn-prev-page', () => {
    if (previewState.page > 1) fetchPreviewPage(previewState.page - 1);
  });
  safeOn('#btn-next-page', () => {
    const maxPage = Math.ceil((previewState.total || 0) / previewState.pageSize) || 1;
    if (previewState.page < maxPage) fetchPreviewPage(previewState.page + 1);
  });
  safeOn('#btn-load-more', () => {
    const maxPage = Math.ceil((previewState.total || 0) / previewState.pageSize) || 1;
    if (previewState.page < maxPage) fetchPreviewPage(previewState.page + 1);
  });

  // Confirm modal
  safeOn('#confirm-cancel', () => closeConfirm(false));
  safeOn('#confirm-ok',     () => closeConfirm(true));

  showLoggedInState();
  loadNotifications();
}

// confirm modal helper (returns Promise)
let _confirmResolve = null;
function confirmAction(message) {
  const modal = $('#confirm-modal');
  $('#confirm-body').textContent = message;
  modal.classList.remove('hidden');
  return new Promise((resolve) => { _confirmResolve = resolve; });
}
function closeConfirm(result) {
  const modal = $('#confirm-modal');
  modal.classList.add('hidden');
  if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
}

// Modal: fetch and render listing details + calendar
async function showListingModal(listingId) {
  const modal = $('#listing-modal');
  const body = $('#modal-body');
  modal.classList.remove('hidden');
  body.innerHTML = `<div id="modal-loader">Loading...</div>`;

  try {
    // Try live details first
    let res = await apiRequest('GET', `/api/listings/details/${listingId}`);
    let listing = res.listing;

    // fallback to DB-backed listing
    if (!listing) {
      res = await apiRequest('GET', `/api/listings/${listingId}`);
      listing = res.listing;
    }

    const photos = (listing.photos && listing.photos.length) ? listing.photos.map(p => (p.url || p)) : [];
    const mainPhoto = photos.length ? photos[0] : '';
    const photoHtml = photos.length ? `
      <div style="margin-bottom:12px">
        <div id="modal-main-photo" style="height:320px;border-radius:8px;overflow:hidden;margin-bottom:8px;background:#0f1113;display:flex;align-items:center;justify-content:center">
          ${mainPhoto ? `<img id="modal-main-img" src="${mainPhoto}" style="max-width:100%;max-height:100%;object-fit:cover"/>` : '<div style="color:var(--muted)">No photo</div>'}
        </div>
        <div class="modal-photos">${photos.slice(0,8).map((p,i)=>`<img src="${p}" data-index="${i}" loading="lazy" style="cursor:pointer"/>`).join('')}</div>
      </div>
    ` : '';

    const amenities = (listing.amenities || []).flatMap(g => (g.values || []).map(v => v.title || v));
    const amenHtml = amenities.length ? `<div class="amenities-list">${amenities.slice(0,20).map(a=>`<span class="amenity">${a}</span>`).join('')}</div>` : '';

    body.innerHTML = `
      <h3>${listing.name || 'Listing'}</h3>
      ${photoHtml}
      <div style="color:rgba(255,255,255,0.8);margin-bottom:8px">${listing.price ? (typeof listing.price === 'object' ? JSON.stringify(listing.price) : ('$'+listing.price)) : ''}</div>
      <div style="margin-bottom:12px">${listing.description || ''}</div>
      <div>${amenHtml}</div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button id="modal-save-alert">Save as alert</button>
        <button id="modal-check-calendar" class="secondary">Check calendar</button>
      </div>
      <pre id="modal-calendar-output" style="margin-top:12px;white-space:pre-wrap;background:rgba(255,255,255,0.02);padding:8px;border-radius:6px;display:none"></pre>
    `;

    $('#modal-save-alert').onclick = async () => {
      const ok = await confirmAction('Save this listing as an alert?');
      if (!ok) return;
      try {
        const btn = $('#modal-save-alert');
        setBtnLoading(btn, true, 'Saving...');
        await apiRequest('POST', '/api/alerts/listing', { listing_id: listingId, listing_url: listing.url || '' });
        showMessage('Listing saved as alert');
        loadAlerts();
      } catch (err) {
        showMessage(err.error || JSON.stringify(err), true);
      }
      finally { setBtnLoading($('#modal-save-alert'), false); }
    };

    $('#modal-check-calendar').onclick = async () => {
      const btn = $('#modal-check-calendar');
      setBtnLoading(btn, true, 'Checking...');
      try {
        const cal = await apiRequest('GET', `/api/listings/calendar/${listingId}`);
        $('#modal-calendar-output').style.display = 'block';
        $('#modal-calendar-output').textContent = JSON.stringify(cal.calendar || cal, null, 2);
      } catch (err) {
        showMessage(err.error || JSON.stringify(err), true);
      } finally {
        setBtnLoading(btn, false);
      }
    };
  } catch (err) {
    body.innerHTML = `<div style="color:var(--danger)">Failed to load details: ${err.error || err.message || JSON.stringify(err)}</div>`;
  }

  // thumbnail click -> update main photo
  document.querySelectorAll('.modal-photos img').forEach(img => {
    img.onclick = (e) => {
      const src = e.target.getAttribute('src');
      const main = $('#modal-main-img');
      if (main) main.src = src;
      // mark selected
      document.querySelectorAll('.modal-photos img').forEach(i => i.style.outline = '');
      e.target.style.outline = '2px solid rgba(255,255,255,0.12)';
    };
  });

  // keyboard: ESC to close, arrows to navigate photos
  const onKey = (ev) => {
    if (ev.key === 'Escape') { modal.classList.add('hidden'); document.removeEventListener('keydown', onKey); }
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      const imgs = Array.from(document.querySelectorAll('.modal-photos img'));
      if (!imgs.length) return;
      const main = $('#modal-main-img');
      const idx = imgs.findIndex(i => i.getAttribute('src') === (main && main.src));
      let next = idx;
      if (ev.key === 'ArrowRight') next = Math.min(imgs.length - 1, idx + 1);
      if (ev.key === 'ArrowLeft') next = Math.max(0, idx - 1);
      imgs[next].click();
    }
  };
  document.addEventListener('keydown', onKey);

  $('#modal-close').onclick = () => { modal.classList.add('hidden'); document.removeEventListener('keydown', onKey); };
  $('#modal-backdrop').onclick = () => { modal.classList.add('hidden'); document.removeEventListener('keydown', onKey); };
}

async function previewSearch() {
  try {
    const location = $('#search-location').value;
    // dates are optional for preview — allow searching by location only
    const check_in = $('#search-check-in').value || null;
    const check_out = $('#search-check-out').value || null;
    const price_min = $('#price-min').value ? parseInt($('#price-min').value, 10) : null;
    const price_max = $('#price-max').value ? parseInt($('#price-max').value, 10) : null;
    const guests = $('#guests').value ? parseInt($('#guests').value, 10) : 1;

    if (!location) {
      return showMessage('Location is required to preview', true);
    }

    const listingsContainer = $('#listings-list');
    // show grid skeleton while fetching
    listingsContainer.innerHTML = '';
    const skGrid = document.createElement('div');
    skGrid.className = 'listing-grid';
    for (let i = 0; i < 6; i++) {
      const sk = document.createElement('div');
      sk.className = 'listing-card skeleton-card';
      sk.innerHTML = `<div class="skeleton skeleton-thumb"></div><div style="flex:1"><div class="skeleton-line" style="width:60%"></div><div class="skeleton-line" style="width:40%"></div></div>`;
      skGrid.appendChild(sk);
    }
    listingsContainer.appendChild(skGrid);

    // collect filter controls
    const premium = !!$('#filter-premium')?.checked;
    const premium_min_price = $('#filter-premium-min')?.value ? parseFloat($('#filter-premium-min').value) : null;
    const popular = !!$('#filter-popular')?.checked;
    const popular_min_reviews = $('#filter-popular-min')?.value ? parseInt($('#filter-popular-min').value, 10) : null;
    const superhost = !!$('#filter-superhost')?.checked;
    const only_saved = !!$('#filter-saved')?.checked;

    // if user picked an autocomplete suggestion, include its bounding box
    const params = {
      location, check_in, check_out, price_min, price_max, guests,
      premium, premium_min_price, popular, popular_min_reviews, superhost, only_saved
    };
    if (selectedLocation && selectedLocation.boundingbox) {
      // Nominatim boundingbox: [south, north, west, east]
      const [south, north, west, east] = selectedLocation.boundingbox.map(Number);
      params.ne_lat = north; params.ne_long = east; params.sw_lat = south; params.sw_long = west;
    }
    previewState.params = params;
    previewState.page = 1;
    previewState.pageSize = parseInt($('#page-size').value, 10) || 20;
    // persist immediately so a refresh doesn't lose this search
    savePreviewToLocalStorage();
    setBtnLoading($('#btn-preview-search'), true);
    try { await fetchPreviewPage(1); } finally { setBtnLoading($('#btn-preview-search'), false); }
    document.getElementById('listings-panel').classList.remove('hidden');
  } catch (err) {
    showMessage(err.error || JSON.stringify(err), true);
  }
}

document.addEventListener('DOMContentLoaded', init);
