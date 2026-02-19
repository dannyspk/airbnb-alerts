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

document.addEventListener('DOMContentLoaded', () => {
  const emailEl = $('#email');
  const passEl = $('#password');
  const btnReg = $('#btn-register');
  const btnLog = $('#btn-login');
  const toggle = $('#toggle-password');

  function updateButtons() {
    const ok = validateEmail(emailEl.value.trim()) && validatePassword(passEl.value || '');
    if (btnReg) btnReg.disabled = !ok;
    if (btnLog) btnLog.disabled = !ok;
  }

  emailEl?.addEventListener('input', updateButtons);
  passEl?.addEventListener('input', updateButtons);

  toggle?.addEventListener('click', (e) => {
    e.preventDefault();
    if (passEl.type === 'password') { passEl.type = 'text'; toggle.textContent = 'Hide'; }
    else { passEl.type = 'password'; toggle.textContent = 'Show'; }
  });

  // allow Enter to submit login
  passEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btnLog.disabled) btnLog.click(); });

  async function doAuth(path) {
    try {
      const email = emailEl.value.trim().toLowerCase();
      const password = passEl.value || '';
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return showMessage(json.error || 'Authentication failed', true);
      if (json.token) {
        localStorage.setItem('token', json.token);
        showMessage(path.endsWith('/register') ? 'Registered — redirecting…' : 'Logged in — redirecting…');
        setTimeout(() => { window.location.href = '/'; }, 600);
      } else {
        showMessage('Unexpected response from server', true);
      }
    } catch (err) {
      showMessage('Request failed', true);
    }
  }

  btnReg?.addEventListener('click', (e) => { e.preventDefault(); doAuth('/api/auth/register'); });
  btnLog?.addEventListener('click', (e) => { e.preventDefault(); doAuth('/api/auth/login'); });

  // initialize state
  updateButtons();
});
