// ── Airbnb Alerts — auth.js ───────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className   = 'toast show' + (isError ? ' error' : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'toast'; }, 4000);
}

// ── View routing ──────────────────────────────────────────────────────────────
const VIEWS = ['login', 'register', 'forgot', 'reset'];

function showView(name) {
  VIEWS.forEach(v => {
    const el = $(`view-${v}`);
    if (el) el.className = 'view' + (v === name ? ' active' : '');
  });
}

// ── Validation ────────────────────────────────────────────────────────────────
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((email || '').trim());
}

function validatePassword(pw) {
  const errors = [];
  if (!pw || pw.length < 8)  errors.push('At least 8 characters');
  if (!/[A-Za-z]/.test(pw)) errors.push('Must contain a letter');
  if (!/[0-9]/.test(pw))    errors.push('Must contain a number');
  return errors;
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(path, body) {
  const res  = await fetch(path, {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    body:        JSON.stringify(body),
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw json;
  return json;
}

// ── Save token & redirect ─────────────────────────────────────────────────────
function finishAuth(token) {
  localStorage.setItem('token', token);
  window.location.href = '/';
}

// ── Password toggle ───────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-pw');
  if (!btn) return;
  const input = $(btn.dataset.target);
  if (!input) return;
  const show = input.type === 'password';
  input.type   = show ? 'text' : 'password';
  btn.textContent = show ? 'Hide' : 'Show';
});

// ── Live validation: register form ───────────────────────────────────────────
function updateRegisterUI() {
  const email = ($('reg-email')?.value   || '').trim();
  const pw    =  $('reg-password')?.value || '';

  const emailHint = $('reg-email-hint');
  const pwHint    = $('reg-password-hint');

  if (emailHint) {
    if (!email)              { emailHint.textContent = ''; emailHint.className = 'field-hint'; }
    else if (isValidEmail(email)) { emailHint.textContent = '✓ Looks good'; emailHint.className = 'field-hint hint-ok'; }
    else                     { emailHint.textContent = 'Invalid email address'; emailHint.className = 'field-hint hint-err'; }
  }

  const pwErrs = validatePassword(pw);
  if (pwHint) {
    if (!pw)           { pwHint.textContent = ''; pwHint.className = 'field-hint'; }
    else if (!pwErrs.length) { pwHint.textContent = '✓ Strong password'; pwHint.className = 'field-hint hint-ok'; }
    else               { pwHint.textContent = pwErrs.join(' · '); pwHint.className = 'field-hint hint-err'; }
  }

  const btn = $('btn-register');
  if (btn) btn.disabled = !(isValidEmail(email) && pwErrs.length === 0);
}

// ── Live validation: reset form ───────────────────────────────────────────────
function updateResetUI() {
  const pw   = $('reset-password')?.value || '';
  const hint = $('reset-password-hint');
  const errs = validatePassword(pw);

  if (hint) {
    if (!pw)       { hint.textContent = ''; hint.className = 'field-hint'; }
    else if (!errs.length) { hint.textContent = '✓ Strong password'; hint.className = 'field-hint hint-ok'; }
    else           { hint.textContent = errs.join(' · '); hint.className = 'field-hint hint-err'; }
  }

  const btn = $('btn-reset');
  if (btn) btn.disabled = errs.length > 0;
}

// ── Set button loading state ──────────────────────────────────────────────────
function setBusy(btn, busy, label) {
  if (!btn) return;
  btn.disabled = busy;
  if (busy)  { btn.dataset.orig = btn.textContent; btn.textContent = label || 'Please wait…'; }
  else if (btn.dataset.orig) { btn.textContent = btn.dataset.orig; delete btn.dataset.orig; }
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleLogin() {
  const btn   = $('btn-login');
  const email = ($('login-email')?.value    || '').trim().toLowerCase();
  const pw    =  $('login-password')?.value || '';

  if (!isValidEmail(email)) return toast('Please enter a valid email.', true);
  if (!pw)                  return toast('Please enter your password.', true);

  setBusy(btn, true, 'Signing in…');
  try {
    const res = await api('/api/auth/login', { email, password: pw });
    finishAuth(res.token);
  } catch (err) {
    toast(err.error || 'Sign in failed — please try again.', true);
  } finally {
    setBusy(btn, false);
  }
}

async function handleRegister() {
  const btn   = $('btn-register');
  const email = ($('reg-email')?.value    || '').trim().toLowerCase();
  const pw    =  $('reg-password')?.value || '';

  if (!isValidEmail(email))       return toast('Please enter a valid email.', true);
  if (validatePassword(pw).length) return toast('Password doesn\'t meet requirements.', true);

  setBusy(btn, true, 'Creating account…');
  try {
    const res = await api('/api/auth/register', { email, password: pw });
    finishAuth(res.token);
  } catch (err) {
    toast(err.error || 'Registration failed — please try again.', true);
  } finally {
    setBusy(btn, false);
  }
}

async function handleForgot() {
  const btn   = $('btn-forgot');
  const email = ($('forgot-email')?.value || '').trim().toLowerCase();

  if (!isValidEmail(email)) return toast('Please enter your email address.', true);

  setBusy(btn, true, 'Sending…');
  try {
    const res = await api('/api/auth/forgot-password', { email });
    toast(res.message || "If that email is registered you'll receive a reset link shortly.");
    // Switch back to login after a short delay
    setTimeout(() => showView('login'), 2500);
  } catch (err) {
    // API always returns 200 for forgot — this only fires on network errors
    toast(err.error || 'Something went wrong — please try again.', true);
  } finally {
    setBusy(btn, false);
  }
}

async function handleReset() {
  const btn   = $('btn-reset');
  const pw    = $('reset-password')?.value || '';
  const token = new URLSearchParams(window.location.search).get('token');

  if (!token) return toast('Invalid reset link — please request a new one.', true);
  if (validatePassword(pw).length) return toast('Password doesn\'t meet requirements.', true);

  setBusy(btn, true, 'Updating…');
  try {
    const res = await api('/api/auth/reset-password', { token, password: pw });
    toast(res.message || 'Password updated! Please sign in.');
    // Clean the token from the URL, switch to login
    history.replaceState({}, '', '/auth.html');
    setTimeout(() => showView('login'), 1800);
  } catch (err) {
    toast(err.error || 'Reset failed — the link may have expired.', true);
  } finally {
    setBusy(btn, false);
  }
}

// ── Allow Enter key on every input ───────────────────────────────────────────
function onEnter(inputId, handler) {
  const el = $(inputId);
  if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') handler(); });
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // If already logged in, skip auth
  if (localStorage.getItem('token')) { window.location.href = '/'; return; }

  // Google OAuth error param
  const params = new URLSearchParams(window.location.search);
  if (params.get('error')) toast('Google sign-in failed — please try again.', true);

  // Token passed back from Google OAuth callback redirect
  const oauthToken = params.get('token');
  if (oauthToken) { finishAuth(oauthToken); return; }

  // Determine initial view from ?mode= query param
  const mode = params.get('mode');
  if (mode === 'register') showView('register');
  else if (mode === 'reset' && params.get('token')) showView('reset');
  else showView('login');

  // Button handlers
  $('btn-login')?.addEventListener('click', handleLogin);
  $('btn-register')?.addEventListener('click', handleRegister);
  $('btn-forgot')?.addEventListener('click', handleForgot);
  $('btn-reset')?.addEventListener('click', handleReset);

  // Mode switchers
  $('link-to-register')?.addEventListener('click', () => showView('register'));
  $('link-to-login')?.addEventListener('click',    () => showView('login'));
  $('link-forgot')?.addEventListener('click',      () => showView('forgot'));
  $('link-back-login')?.addEventListener('click',  () => showView('login'));

  // Live validation
  $('reg-email')?.addEventListener('input', updateRegisterUI);
  $('reg-password')?.addEventListener('input', updateRegisterUI);
  $('reset-password')?.addEventListener('input', updateResetUI);

  // Enter key shortcuts
  onEnter('login-email',    handleLogin);
  onEnter('login-password', handleLogin);
  onEnter('reg-email',      handleRegister);
  onEnter('reg-password',   handleRegister);
  onEnter('forgot-email',   handleForgot);
  onEnter('reset-password', handleReset);
});
