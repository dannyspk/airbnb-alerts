// Minimal auth page script (register/login)
const $a = (s) => document.querySelector(s);

function showMessageAuth(msg, isError = false) {
  const el = document.getElementById('message');
  el.textContent = msg;
  el.className = `message ${isError ? 'error' : 'success'}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

async function apiAuth(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin'
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw json;
  return json;
}

async function handleRegister() {
  // client-side validation before sending
  if (!validateEmail($a('#email').value)) return showMessageAuth('Please enter a valid email', true);
  const pwdErr = validatePassword($a('#password').value);
  if (pwdErr.length) return showMessageAuth(pwdErr.join('; '), true);
  try {
    const email = $a('#email').value.trim().toLowerCase();
    const password = $a('#password').value;
    const res = await apiAuth('/api/auth/register', { email, password });
    localStorage.setItem('token', res.token);
    showMessageAuth('Registered — redirecting...');
    window.location.href = '/';
  } catch (err) {
    showMessageAuth(err.error || JSON.stringify(err), true);
  }
}

async function handleLogin() {
  if (!validateEmail($a('#email').value)) return showMessageAuth('Please enter a valid email', true);
  if ($a('#password').value.length < 1) return showMessageAuth('Please enter your password', true);
  try {
    const email = $a('#email').value.trim().toLowerCase();
    const password = $a('#password').value;
    const res = await apiAuth('/api/auth/login', { email, password });
    localStorage.setItem('token', res.token);
    showMessageAuth('Login successful — redirecting...');
    window.location.href = '/';
  } catch (err) {
    showMessageAuth(err.error || JSON.stringify(err), true);
  }
}

function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function validatePassword(pw) {
  const errors = [];
  if (!pw || pw.length < 8) errors.push('At least 8 characters');
  if (!/[A-Za-z]/.test(pw)) errors.push('Include a letter');
  if (!/[0-9]/.test(pw)) errors.push('Include a number');
  return errors;
}

function updateValidationUI() {
  const email = $a('#email').value;
  const pw = $a('#password').value;
  const emailHelp = $a('#email-help');
  const pwdHelp = $a('#password-help');

  if (email.length === 0) {
    emailHelp.textContent = '';
  } else if (validateEmail(email)) {
    emailHelp.textContent = 'Looks good';
    emailHelp.className = 'field-ok';
  } else {
    emailHelp.textContent = 'Invalid email address';
    emailHelp.className = 'field-error';
  }

  const pwdErr = validatePassword(pw);
  if (pw.length === 0) {
    pwdHelp.textContent = 'At least 8 characters, include letters and numbers.';
    pwdHelp.className = 'note';
  } else if (pwdErr.length === 0) {
    pwdHelp.textContent = 'Strong password';
    pwdHelp.className = 'field-ok';
  } else {
    pwdHelp.textContent = pwdErr.join('; ');
    pwdHelp.className = 'field-error';
  }

  const enable = validateEmail(email) && pw.length >= 1;
  $a('#btn-register').disabled = !(validateEmail(email) && pwdErr.length === 0);
  $a('#btn-login').disabled = !enable;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-register').onclick = handleRegister;
  document.getElementById('btn-login').onclick = handleLogin;

  // live validation
  $a('#email').addEventListener('input', updateValidationUI);
  $a('#password').addEventListener('input', updateValidationUI);

  // password toggle
  $a('#toggle-password').addEventListener('click', (e) => {
    const input = $a('#password');
    if (input.type === 'password') { input.type = 'text'; e.target.textContent = 'Hide'; }
    else { input.type = 'password'; e.target.textContent = 'Show'; }
  });

  const token = localStorage.getItem('token');
  if (token) {
    // already logged in — go to dashboard
    window.location.href = '/';
  }
  updateValidationUI();
});

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-register').onclick = handleRegister;
  document.getElementById('btn-login').onclick = handleLogin;
  const token = localStorage.getItem('token');
  if (token) {
    // already logged in — go to dashboard
    window.location.href = '/';
  }
});

