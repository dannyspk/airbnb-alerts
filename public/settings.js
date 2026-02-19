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

function handleLogout() {
  // notify server to revoke refresh token cookie
  apiRequest('POST', '/api/auth/logout').catch(() => {});
  localStorage.removeItem('token');
  showMessage('Logged out');
  // go back to auth page
  window.location.href = '/auth.html';
}

function init() {
  // Redirect to auth page if not signed in
  const token = localStorage.getItem('token');
  if (!token) return window.location.href = '/auth.html';

  // Wire up buttons
  $('#btn-logout').addEventListener('click', handleLogout);
}

init();