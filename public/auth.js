const $ = (sel) => document.querySelector(sel);

function showMessage(msg, isError = false) {
  const el = $('#message');
  if (!el) return;
  el.textContent = msg;
  el.className = `message ${isError ? 'error' : 'success'}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function validateEmail(v) { return typeof v === 'string' && v.includes('@') && v.indexOf(' ') === -1; }
function validatePassword(v) { return typeof v === 'string' && v.length >= 8; }

function switchToForm(formId) {
  if (formId === 'auth') {
    // Show the login/register tabs
    document.querySelectorAll('#login-card, #register-card, #forgot-password-card, #reset-password-card').forEach(card => card.style.display = 'none');
    switchToTab('login');
    return;
  }
  // Hide all forms first
  document.querySelectorAll('#login-card, #register-card, #forgot-password-card, #reset-password-card').forEach(card => card.style.display = 'none');
  const form = $(`#${formId}-card`);
  if (form) form.style.display = 'block';
}

function switchToTab(tab) {
  const loginTab = $('#tab-login');
  const registerTab = $('#tab-register');
  const loginCard = $('#login-card');
  const registerCard = $('#register-card');
  
  // Hide all other forms first
  document.querySelectorAll('#forgot-password-card, #reset-password-card').forEach(card => card.style.display = 'none');
  
  if (tab === 'login') {
    loginTab.classList.add('active');
    registerTab.classList.remove('active');
    loginTab.style.color = 'var(--text)';
    registerTab.style.color = 'var(--muted)';
    loginTab.style.borderBottomColor = 'var(--accent)';
    registerTab.style.borderBottomColor = 'transparent';
    loginCard.style.display = 'block';
    registerCard.style.display = 'none';
  } else {
    registerTab.classList.add('active');
    loginTab.classList.remove('active');
    registerTab.style.color = 'var(--text)';
    loginTab.style.color = 'var(--muted)';
    registerTab.style.borderBottomColor = 'var(--accent)';
    loginTab.style.borderBottomColor = 'transparent';
    registerCard.style.display = 'block';
    loginCard.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // ===== TAB SWITCHING =====
  const loginTab = $('#tab-login');
  const registerTab = $('#tab-register');
  loginTab?.addEventListener('click', () => switchToTab('login'));
  registerTab?.addEventListener('click', () => switchToTab('register'));

  // ===== LOGIN FORM =====
  const loginEmailEl = $('#login-email');
  const loginPassEl = $('#login-password');
  const btnLogin = $('#btn-login');
  const toggleLoginPassword = $('#toggle-login-password');
  const btnForgotPassword = $('#btn-forgot-password');

  function updateLoginButton() {
    const ok = validateEmail(loginEmailEl.value.trim()) && validatePassword(loginPassEl.value || '');
    if (btnLogin) btnLogin.disabled = !ok;
  }

  loginEmailEl?.addEventListener('input', updateLoginButton);
  loginPassEl?.addEventListener('input', updateLoginButton);

  toggleLoginPassword?.addEventListener('click', (e) => {
    e.preventDefault();
    if (loginPassEl.type === 'password') { loginPassEl.type = 'text'; toggleLoginPassword.textContent = 'Hide'; }
    else { loginPassEl.type = 'password'; toggleLoginPassword.textContent = 'Show'; }
  });

  loginPassEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btnLogin.disabled) btnLogin.click(); });

  btnLogin?.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const email = loginEmailEl.value.trim().toLowerCase();
      const password = loginPassEl.value || '';
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return showMessage(json.error || 'Authentication failed', true);
      if (json.accessToken) {
        localStorage.setItem('accessToken', json.accessToken);
        localStorage.setItem('refreshToken', json.refreshToken);
        localStorage.setItem('userId', json.userId);
        showMessage('Logged in — redirecting…');
        setTimeout(() => { window.location.href = '/'; }, 600);
      } else if (json.token) {
        // backward compatibility with old token format
        localStorage.setItem('token', json.token);
        showMessage('Logged in — redirecting…');
        setTimeout(() => { window.location.href = '/'; }, 600);
      } else {
        showMessage('Unexpected response from server', true);
      }
    } catch (err) {
      showMessage('Request failed', true);
    }
  });

  btnForgotPassword?.addEventListener('click', (e) => { e.preventDefault(); switchToForm('forgot-password'); });

  // ===== REGISTER FORM =====
  const registerEmailEl = $('#register-email');
  const registerPassEl = $('#register-password');
  const btnRegister = $('#btn-register');
  const toggleRegisterPassword = $('#toggle-register-password');

  function updateRegisterButton() {
    const ok = validateEmail(registerEmailEl.value.trim()) && validatePassword(registerPassEl.value || '');
    if (btnRegister) btnRegister.disabled = !ok;
  }

  registerEmailEl?.addEventListener('input', updateRegisterButton);
  registerPassEl?.addEventListener('input', updateRegisterButton);

  toggleRegisterPassword?.addEventListener('click', (e) => {
    e.preventDefault();
    if (registerPassEl.type === 'password') { registerPassEl.type = 'text'; toggleRegisterPassword.textContent = 'Hide'; }
    else { registerPassEl.type = 'password'; toggleRegisterPassword.textContent = 'Show'; }
  });

  registerPassEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btnRegister.disabled) btnRegister.click(); });

  btnRegister?.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const email = registerEmailEl.value.trim().toLowerCase();
      const password = registerPassEl.value || '';
      const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return showMessage(json.error || 'Registration failed', true);
      if (json.accessToken) {
        localStorage.setItem('accessToken', json.accessToken);
        localStorage.setItem('refreshToken', json.refreshToken);
        localStorage.setItem('userId', json.userId);
        showMessage('Registered — redirecting…');
        setTimeout(() => { window.location.href = '/'; }, 600);
      } else if (json.token) {
        // backward compatibility with old token format
        localStorage.setItem('token', json.token);
        showMessage('Registered — redirecting…');
        setTimeout(() => { window.location.href = '/'; }, 600);
      } else {
        showMessage('Unexpected response from server', true);
      }
    } catch (err) {
      showMessage('Request failed', true);
    }
  });

  // ===== FORGOT PASSWORD FORM =====
  const forgotEmailEl = $('#forgot-email');
  const btnSendReset = $('#btn-send-reset');
  const btnBackToLogin = $('#btn-back-to-login');

  function updateForgotButton() {
    const ok = validateEmail(forgotEmailEl.value.trim());
    if (btnSendReset) btnSendReset.disabled = !ok;
  }

  forgotEmailEl?.addEventListener('input', updateForgotButton);
  forgotEmailEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btnSendReset.disabled) btnSendReset.click(); });

  btnSendReset?.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const email = forgotEmailEl.value.trim().toLowerCase();
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
        credentials: 'same-origin'
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return showMessage(json.error || 'Failed to send reset link', true);
      showMessage('Reset link sent to your email. Check your inbox!');
      setTimeout(() => { switchToForm('auth'); forgotEmailEl.value = ''; updateForgotButton(); }, 2000);
    } catch (err) {
      showMessage('Request failed', true);
    }
  });

  btnBackToLogin?.addEventListener('click', (e) => { e.preventDefault(); switchToForm('auth'); });

  // ===== RESET PASSWORD FORM (from email link) =====
  const resetPassEl = $('#reset-password');
  const resetConfirmEl = $('#reset-confirm');
  const btnResetPassword = $('#btn-reset-password');
  const toggleResetPassword = $('#toggle-reset-password');
  const btnBackToLogin2 = $('#btn-back-to-login-2');

  function updateResetButton() {
    const pass = resetPassEl.value || '';
    const confirm = resetConfirmEl.value || '';
    const ok = validatePassword(pass) && pass === confirm;
    if (btnResetPassword) btnResetPassword.disabled = !ok;
  }

  resetPassEl?.addEventListener('input', updateResetButton);
  resetConfirmEl?.addEventListener('input', updateResetButton);
  resetConfirmEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btnResetPassword.disabled) btnResetPassword.click(); });

  toggleResetPassword?.addEventListener('click', (e) => {
    e.preventDefault();
    if (resetPassEl.type === 'password') {
      resetPassEl.type = 'text';
      resetConfirmEl.type = 'text';
      toggleResetPassword.textContent = 'Hide';
    } else {
      resetPassEl.type = 'password';
      resetConfirmEl.type = 'password';
      toggleResetPassword.textContent = 'Show';
    }
  });

  btnResetPassword?.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const token = new URLSearchParams(window.location.search).get('reset_token');
      if (!token) return showMessage('Invalid reset link', true);

      const password = resetPassEl.value;
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
        credentials: 'same-origin'
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return showMessage(json.error || 'Failed to reset password', true);
      showMessage('Password reset successfully! Redirecting to login...');
      setTimeout(() => { window.location.href = '/auth.html'; }, 2000);
    } catch (err) {
      showMessage('Request failed', true);
    }
  });

  btnBackToLogin2?.addEventListener('click', (e) => { e.preventDefault(); switchToForm('auth'); });

  // ===== GOOGLE OAUTH =====
  const btnGoogleLogin = $('#btn-google-login');
  const btnGoogleRegister = $('#btn-google-register');
  btnGoogleLogin?.addEventListener('click', (e) => {
    e.preventDefault();
    // Redirect to Google OAuth endpoint
    window.location.href = '/api/auth/google';
  });
  btnGoogleRegister?.addEventListener('click', (e) => {
    e.preventDefault();
    // Redirect to Google OAuth endpoint (same endpoint for both login and register)
    window.location.href = '/api/auth/google';
  });

  // Check if we're returning from Google OAuth callback
  const params = new URLSearchParams(window.location.search);
  if (params.has('accessToken')) {
    const accessToken = params.get('accessToken');
    const refreshToken = params.get('refreshToken');
    const userId = params.get('userId');
    if (accessToken && refreshToken) {
      localStorage.setItem('accessToken', accessToken);
      localStorage.setItem('refreshToken', refreshToken);
      localStorage.setItem('userId', userId);
      showMessage('Logged in with Google — redirecting…');
      // Clean up URL
      window.history.replaceState({}, document.title, '/auth.html');
      setTimeout(() => { window.location.href = '/'; }, 600);
    }
  }

  // Check if we need to show the reset password form
  if (params.has('reset_token')) {
    switchToForm('reset-password');
  } else {
    // Default to login tab
    switchToTab('login');
  }

  // initialize state
  updateLoginButton();
  updateRegisterButton();
  updateForgotButton();
});

