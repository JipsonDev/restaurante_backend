import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCorsOrigins, trustProxySetting } from '../services/httpSecurity.js';

test('production refuses an open CORS configuration', () => {
  assert.throws(() => resolveCorsOrigins({ NODE_ENV: 'production' }));
  assert.throws(() => resolveCorsOrigins({ NODE_ENV: 'production', CORS_ORIGIN: '*' }));
  assert.deepEqual(resolveCorsOrigins({ NODE_ENV: 'production', CORS_ORIGIN: 'https://a.app, https://b.app' }), ['https://a.app', 'https://b.app']);
  assert.equal(resolveCorsOrigins({}), '*');
});

test('trust proxy defaults to one hop only in production and can be overridden', () => {
  assert.equal(trustProxySetting({ NODE_ENV: 'production' }), 1);
  assert.equal(trustProxySetting({}), false);
  assert.equal(trustProxySetting({ TRUST_PROXY: '2' }), 2);
  assert.equal(trustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: 'false' }), false);
});
