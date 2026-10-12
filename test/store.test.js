import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretStore } from '../src/store.js';

test('take burns after maxReads', () => {
  const s = new SecretStore();
  const { id } = s.put('abc', { ttlSeconds: 60, maxReads: 2 });
  assert.equal(s.take(id), 'abc');
  assert.equal(s.take(id), 'abc');
  assert.equal(s.take(id), null);
  assert.equal(s.totalBytes, 0);
  s.close();
});

test('expired items are gone', () => {
  let t = 1000;
  const s = new SecretStore({ now: () => t });
  const { id } = s.put('abc', { ttlSeconds: 60, maxReads: 1 });
  t += 60_000;
  assert.equal(s.take(id), null);
  s.close();
});

test('delete requires the right token', () => {
  const s = new SecretStore();
  const { id, deleteToken } = s.put('abc', { ttlSeconds: 60, maxReads: 1 });
  assert.equal(s.delete(id, 'wrong'), false);
  assert.equal(s.delete(id, deleteToken), true);
  assert.equal(s.take(id), null);
  s.close();
});

test('capacity limit', () => {
  const s = new SecretStore({ maxTotalBytes: 5 });
  assert.ok(s.put('abc', { ttlSeconds: 60, maxReads: 1 }));
  assert.equal(s.put('abc', { ttlSeconds: 60, maxReads: 1 }), null);
  s.close();
});
