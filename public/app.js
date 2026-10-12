import { generateKey, encrypt } from './crypto.js';
import { buildPrompt, NAME_RE } from './prompt.js';

const $ = (id) => document.getElementById(id);
const form = $('create');
let current = null; // { id, deleteToken, pollTimer }

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = `status ${cls}`;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const name = $('name').value.trim();
  const secret = $('secret').value;
  if (!NAME_RE.test(name)) return showError('Name must be letters, digits and underscores, not starting with a digit.');
  if (!secret) return showError('Enter a secret.');

  $('submit').disabled = true;
  try {
    const key = await generateKey();
    const ciphertext = await encrypt(secret, key);
    const maxReads = Number($('reads').value);
    const res = await fetch('/api/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciphertext, ttlSeconds: Number($('ttl').value), maxReads }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);

    const revealUrl = `${location.origin}/api/secrets/${data.id}/reveal`;
    $('prompt').value = buildPrompt({
      revealUrl, key, name, maxReads,
      expiresAt: data.expiresAt,
      instructions: $('instructions').value,
    });
    $('secret').value = '';
    current = { id: data.id, deleteToken: data.deleteToken };
    form.hidden = true;
    $('result').hidden = false;
    setStatus('Waiting for retrieval…');
    startPolling();
  } catch (err) {
    showError(err.message);
  } finally {
    $('submit').disabled = false;
  }
});

function startPolling() {
  const poll = async () => {
    if (!current) return;
    try {
      const res = await fetch(`/api/secrets/${current.id}`);
      if (res.status === 404) {
        setStatus('Retrieved, expired, or revoked: the link is now dead', 'done');
        $('revoke').disabled = true;
        return stopPolling();
      }
      const { readsLeft } = await res.json();
      setStatus(`Waiting for retrieval… (${readsLeft} left)`);
    } catch { /* transient, keep polling */ }
  };
  current.pollTimer = setInterval(poll, 3000);
}

function stopPolling() {
  if (current?.pollTimer) clearInterval(current.pollTimer);
}

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('prompt').value);
    $('copy').textContent = 'Copied ✓';
  } catch {
    $('prompt').select();
    $('copy').textContent = 'Press Ctrl/Cmd+C';
  }
  setTimeout(() => ($('copy').textContent = 'Copy prompt'), 2000);
});

$('revoke').addEventListener('click', async () => {
  if (!current) return;
  const res = await fetch(`/api/secrets/${current.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${current.deleteToken}` },
  });
  setStatus(res.status === 204 ? 'Revoked' : 'Already gone (retrieved or expired)', 'done');
  $('revoke').disabled = true;
  stopPolling();
});

$('again').addEventListener('click', () => {
  stopPolling();
  current = null;
  $('prompt').value = '';
  $('revoke').disabled = false;
  $('result').hidden = true;
  form.hidden = false;
  form.reset();
});
