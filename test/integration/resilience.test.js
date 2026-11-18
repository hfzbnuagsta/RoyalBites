// Test integrasi: kegagalan database, rate limiting, pengaturan production, dan keamanan log.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { runMigrations } from '../../src/db/migrate.js';
import { createLogger } from '../../src/utils/logger.js';
import {
  ADMIN_PASSWORD,
  clearData,
  createAdmin,
  insertProduct,
  orderPayload,
  prepareDatabase,
  startTestServer,
  testConfig,
} from '../helpers.js';

before(async () => {
  await prepareDatabase(testConfig());
});

describe('migrasi database', () => {
  test('dijalankan ulang tidak mengubah apa pun (idempoten)', async () => {
    const config = testConfig();
    const result = await runMigrations(config.db);
    assert.deepEqual(result.applied, []);
    assert.ok(result.total >= 2);
  });
});

describe('database tidak tersedia', () => {
  let ctx;
  before(async () => {
    // Port 1 tidak ada layanan MySQL-nya => koneksi ditolak.
    ctx = await startTestServer({ DB_PORT: '1' });
  });
  after(() => ctx.stop());

  test('health check melaporkan 503 tanpa detail', async () => {
    const { status, data } = await ctx.client().get('/api/health');
    assert.equal(status, 503);
    assert.deepEqual(data, { status: 'degraded', database: 'down' });
  });

  test('menu, pesanan, login: 503 dengan pesan ramah, tanpa stack/SQL/alamat server', async () => {
    const client = ctx.client();
    const responses = [
      await client.get('/api/products'),
      await client.get('/api/config'),
      await client.post('/api/orders', orderPayload([{ product_id: 1, quantity: 1, price: 1000 }])),
      await client.post('/api/admin/login', { username: 'owner', password: ADMIN_PASSWORD }),
    ];
    for (const response of responses) {
      assert.equal(response.status, 503, JSON.stringify(response.data));
      assert.equal(response.data.error.code, 'SERVICE_UNAVAILABLE');
      const text = JSON.stringify(response.data);
      assert.ok(!/ECONNREFUSED|127\.0\.0\.1|mysql|\bat \w|node_modules|\.js:\d+/i.test(text), `bocor: ${text}`);
    }
  });
});

describe('error internal tak terduga', () => {
  test('menghasilkan 500 generik tanpa detail', async () => {
    const ctx = await startTestServer();
    await ctx.pool.end(); // memaksa error "Pool is closed" pada query berikutnya
    const { status, data } = await ctx.client().get('/api/products');
    assert.equal(status, 500);
    assert.equal(data.error.code, 'INTERNAL_ERROR');
    assert.ok(!/pool|closed|stack|\.js/i.test(JSON.stringify(data)));
    await new Promise((resolve) => ctx.stop().then(resolve, resolve));
  });
});

describe('rate limiting', () => {
  test('login: setelah batas percobaan GAGAL, request berikutnya 429 (walau password benar)', async () => {
    const ctx = await startTestServer({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_LOGIN_ATTEMPTS: '3' });
    try {
      await clearData(ctx.pool);
      await createAdmin(ctx);
      const client = ctx.client();
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await client.post('/api/admin/login', { username: 'owner', password: 'salah-salah-salah' })).status, 401);
      }
      const blocked = await client.post('/api/admin/login', { username: 'owner', password: ADMIN_PASSWORD });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.data.error.code, 'RATE_LIMITED');
    } finally {
      await ctx.stop();
    }
  });

  test('login yang berhasil tidak menghabiskan jatah', async () => {
    const ctx = await startTestServer({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_LOGIN_ATTEMPTS: '3' });
    try {
      await clearData(ctx.pool);
      await createAdmin(ctx);
      for (let i = 0; i < 6; i += 1) assert.equal((await ctx.client().login()).status, 200);
    } finally {
      await ctx.stop();
    }
  });

  test('pesanan dan formulir kontak dibatasi per IP', async () => {
    const ctx = await startTestServer({ RATE_LIMIT_ENABLED: 'true' });
    try {
      const client = ctx.client();
      let lastContact;
      for (let i = 0; i < 11; i += 1) lastContact = await client.post('/api/contact', { name: 'Spam', message: 'pesan spam ke-' + i });
      assert.equal(lastContact.status, 429);
      let lastOrder;
      for (let i = 0; i < 31; i += 1) lastOrder = await client.post('/api/orders', {});
      assert.equal(lastOrder.status, 429);
    } finally {
      await ctx.stop();
    }
  });
});

describe('konfigurasi production', () => {
  test('cookie __Host-, Secure, HttpOnly, SameSite=Strict, tanpa Domain; HSTS & upgrade-insecure-requests', async () => {
    const ctx = await startTestServer({ NODE_ENV: 'production', COOKIE_SECURE: 'true' });
    try {
      await clearData(ctx.pool);
      await createAdmin(ctx);
      const client = ctx.client();
      const login = await client.login();
      assert.equal(login.status, 200);
      const cookie = login.setCookie.find((c) => c.startsWith('__Host-rb_admin='));
      assert.ok(cookie, `cookie: ${login.setCookie}`);
      assert.match(cookie, /; Secure/i);
      assert.match(cookie, /; HttpOnly/i);
      assert.match(cookie, /; SameSite=Strict/i);
      assert.match(cookie, /; Path=\//i);
      assert.doesNotMatch(cookie, /Domain=/i);
      assert.equal((await client.get('/api/admin/session')).status, 200);

      const headers = (await client.get('/api/health')).headers;
      assert.match(headers.get('strict-transport-security'), /max-age=\d+/);
      assert.match(headers.get('content-security-policy'), /upgrade-insecure-requests/);
    } finally {
      await ctx.stop();
    }
  });

  test('FORCE_HTTPS mengalihkan HTTP ke HTTPS, kecuali di belakang proxy HTTPS', async () => {
    const ctx = await startTestServer({ FORCE_HTTPS: 'true', TRUST_PROXY: '1' });
    try {
      const plain = await fetch(`${ctx.baseUrl}/api/health`, { redirect: 'manual' });
      assert.equal(plain.status, 308);
      assert.match(plain.headers.get('location'), /^https:\/\/127\.0\.0\.1:\d+\/api\/health$/);
      const proxied = await fetch(`${ctx.baseUrl}/api/health`, { headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(proxied.status, 200);
    } finally {
      await ctx.stop();
    }
  });
});

describe('header keamanan dan respons error', () => {
  let ctx;
  before(async () => {
    ctx = await startTestServer();
  });
  after(() => ctx.stop());

  test('CSP ketat, nosniff, tanpa X-Powered-By, API tidak di-cache', async () => {
    const response = await ctx.client().get('/api/products');
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  test('endpoint tak dikenal di /api => 404 JSON; metode salah tidak membocorkan apa pun', async () => {
    const client = ctx.client();
    const missing = await client.get('/api/tidak-ada');
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error.code, 'NOT_FOUND');
    assert.equal((await client.delete('/api/products')).status, 404);
  });

  test('CORS: tanpa daftar origin, tidak ada header CORS (hanya same-origin)', async () => {
    const response = await ctx.client().get('/api/products', { headers: { origin: 'https://evil.example' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  test('CORS: dengan daftar origin, hanya origin terdaftar yang diizinkan', async () => {
    const withCors = await startTestServer({ CORS_ORIGINS: 'https://toko.example' });
    try {
      const good = await withCors.client().get('/api/products', { headers: { origin: 'https://toko.example' } });
      assert.equal(good.headers.get('access-control-allow-origin'), 'https://toko.example');
      assert.equal(good.headers.get('access-control-allow-credentials'), null, 'cookie admin tidak boleh ikut lintas origin');
      const bad = await withCors.client().get('/api/products', { headers: { origin: 'https://evil.example' } });
      assert.notEqual(bad.headers.get('access-control-allow-origin'), 'https://evil.example');
    } finally {
      await withCors.stop();
    }
  });
});

describe('log tidak membocorkan data sensitif', () => {
  test('password, nomor telepon, alamat, token, dan cookie tidak muncul di log', async () => {
    const lines = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    const capture = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    const ctx = await startTestServer({ LOG_LEVEL: 'debug' }, { logger: createLogger('debug') });
    try {
      await clearData(ctx.pool);
      await createAdmin(ctx);
      const product = await insertProduct(ctx.pool, { price: 5000 });
      process.stdout.write = capture;
      process.stderr.write = capture;
      const client = ctx.client();
      await client.post('/api/admin/login', { username: 'owner', password: 'password-salah-rahasia-123' });
      const login = await client.login();
      await client.post('/api/orders', orderPayload([{ product_id: product.id, quantity: 1, price: 5000 }], {
        customer_phone: '081299887766',
        customer_name: 'Nama Rahasia Pelanggan',
        customer_notes: 'catatan-pribadi-xyz',
      }));
      await client.get('/api/admin/orders?q=nama-rahasia-pencarian');
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;

      const log = lines.join('');
      assert.ok(log.includes('"msg":"request"'), 'log request harus ada');
      for (const secret of ['password-salah-rahasia-123', ADMIN_PASSWORD, '081299887766', '6281299887766', 'Nama Rahasia Pelanggan', 'catatan-pribadi-xyz', 'nama-rahasia-pencarian', login.data.csrf_token, client.cookies.get('rb_admin')]) {
        assert.ok(!log.includes(secret), `log memuat data sensitif: ${secret}`);
      }
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      await ctx.stop();
    }
  });
});
