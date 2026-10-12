import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest();

/**
 * In-memory, expiring, read-limited store for opaque ciphertext blobs.
 * Nothing is ever written to disk; a restart wipes every secret.
 */
export class SecretStore {
  constructor({ maxTotalBytes = 50 * 1024 * 1024, sweepIntervalMs = 15_000, now = Date.now } = {}) {
    this.items = new Map();
    this.totalBytes = 0;
    this.maxTotalBytes = maxTotalBytes;
    this.now = now;
    this.timer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.timer.unref();
  }

  put(ciphertext, { ttlSeconds, maxReads }) {
    this.sweep();
    if (this.totalBytes + ciphertext.length > this.maxTotalBytes) return null;
    const id = randomBytes(16).toString('base64url');
    const deleteToken = randomBytes(16).toString('base64url');
    const expiresAt = this.now() + ttlSeconds * 1000;
    this.items.set(id, { ciphertext, expiresAt, readsLeft: maxReads, deleteTokenHash: sha256(deleteToken) });
    this.totalBytes += ciphertext.length;
    return { id, deleteToken, expiresAt };
  }

  /** Returns the ciphertext and consumes one read, or null if missing/expired. */
  take(id) {
    const item = this.#live(id);
    if (!item) return null;
    item.readsLeft -= 1;
    if (item.readsLeft <= 0) this.#remove(id);
    return item.ciphertext;
  }

  status(id) {
    const item = this.#live(id);
    return item ? { expiresAt: item.expiresAt, readsLeft: item.readsLeft } : null;
  }

  delete(id, deleteToken) {
    const item = this.#live(id);
    if (!item || typeof deleteToken !== 'string') return false;
    if (!timingSafeEqual(sha256(deleteToken), item.deleteTokenHash)) return false;
    this.#remove(id);
    return true;
  }

  sweep() {
    const t = this.now();
    for (const [id, item] of this.items) if (item.expiresAt <= t) this.#remove(id);
  }

  close() {
    clearInterval(this.timer);
    this.items.clear();
    this.totalBytes = 0;
  }

  #live(id) {
    const item = this.items.get(id);
    if (!item) return null;
    if (item.expiresAt <= this.now()) {
      this.#remove(id);
      return null;
    }
    return item;
  }

  #remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.totalBytes -= item.ciphertext.length;
    this.items.delete(id);
  }
}
