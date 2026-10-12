// Client-side encryption. Runs in the browser (and in Node >= 20 for tests).
// Wire format: base64url( iv[12] || AES-256-GCM ciphertext || tag[16] )

const subtle = globalThis.crypto.subtle;

export function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Generates a fresh 256-bit key. Returns the raw key as base64url; it never leaves the browser except in the prompt. */
export async function generateKey() {
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return toBase64Url(new Uint8Array(await subtle.exportKey('raw', key)));
}

export async function encrypt(plaintext, keyB64) {
  const key = await subtle.importKey('raw', fromBase64Url(keyB64), 'AES-GCM', false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64Url(out);
}

export async function decrypt(payloadB64, keyB64) {
  const key = await subtle.importKey('raw', fromBase64Url(keyB64), 'AES-GCM', false, ['decrypt']);
  const buf = fromBase64Url(payloadB64);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12));
  return new TextDecoder().decode(pt);
}
