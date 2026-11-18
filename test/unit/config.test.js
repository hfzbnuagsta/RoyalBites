// Test unit: pembacaan konfigurasi dan aturan keamanan wajib di production.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertRunnable, loadConfig } from '../../src/config/env.js';
import { serializeError } from '../../src/utils/logger.js';

const baseEnv = { DB_USER: 'app', DB_NAME: 'royal_bites', DB_PASSWORD: 'rahasia-db-yang-kuat' };

describe('loadConfig', () => {
  test('default aman untuk development', () => {
    const config = loadConfig({ ...baseEnv });
    assert.equal(config.isProduction, false);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.session.secureCookie, false);
    assert.equal(config.rateLimit.enabled, true);
    assert.equal(config.businessUtcOffsetMinutes, 420);
  });
  test('production: cookie Secure aktif otomatis dan host 0.0.0.0', () => {
    const config = loadConfig({ ...baseEnv, NODE_ENV: 'production' });
    assert.equal(config.session.secureCookie, true);
    assert.equal(config.host, '0.0.0.0');
  });
  test('nilai angka tidak valid ditolak dengan pesan jelas', () => {
    assert.throws(() => loadConfig({ ...baseEnv, PORT: 'abc' }), /PORT tidak valid/);
    assert.throws(() => loadConfig({ ...baseEnv, PORT: '70000' }), /PORT tidak valid/);
    assert.throws(() => loadConfig({ ...baseEnv, BCRYPT_COST: '99' }), /BCRYPT_COST/);
  });
  test('TRUST_PROXY dan CORS_ORIGINS di-parse', () => {
    assert.equal(loadConfig({ ...baseEnv, TRUST_PROXY: '1' }).trustProxy, 1);
    assert.equal(loadConfig({ ...baseEnv, TRUST_PROXY: 'false' }).trustProxy, false);
    assert.deepEqual(loadConfig({ ...baseEnv, CORS_ORIGINS: 'https://a.com, https://b.com ,' }).corsOrigins, ['https://a.com', 'https://b.com']);
  });
});

describe('assertRunnable (penjaga konfigurasi)', () => {
  test('menolak jika DB_USER / DB_NAME kosong', () => {
    assert.throws(() => assertRunnable(loadConfig({})), /DB_USER, DB_NAME/);
  });
  test('production menolak DB tanpa password', () => {
    assert.throws(() => assertRunnable(loadConfig({ ...baseEnv, DB_PASSWORD: '', NODE_ENV: 'production' })), /DB_PASSWORD/);
  });
  test('production menolak rate limit dimatikan', () => {
    assert.throws(() => assertRunnable(loadConfig({ ...baseEnv, NODE_ENV: 'production', RATE_LIMIT_ENABLED: 'false' })), /RATE_LIMIT_ENABLED/);
  });
  test('production menolak cookie non-Secure', () => {
    assert.throws(() => assertRunnable(loadConfig({ ...baseEnv, NODE_ENV: 'production', COOKIE_SECURE: 'false' })), /COOKIE_SECURE/);
  });
  test('konfigurasi production yang benar lolos', () => {
    assert.doesNotThrow(() => assertRunnable(loadConfig({ ...baseEnv, NODE_ENV: 'production' })));
  });
});

describe('serializeError (log tidak membocorkan data)', () => {
  test('tidak memuat SQL, nilai parameter, atau pesan database', () => {
    const error = Object.assign(new Error("Duplicate entry '6281234567890' for key 'orders.phone'"), {
      code: 'ER_DUP_ENTRY',
      sql: "INSERT INTO orders (customer_phone) VALUES ('6281234567890')",
      sqlMessage: "Duplicate entry '6281234567890' for key 'orders.phone'",
      values: ['6281234567890'],
    });
    const json = JSON.stringify(serializeError(error));
    assert.ok(!json.includes('6281234567890'));
    assert.ok(!json.includes('INSERT'));
    assert.ok(json.includes('ER_DUP_ENTRY'));
  });
});
