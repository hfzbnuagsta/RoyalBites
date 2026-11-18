// Alat bantu untuk test: server sungguhan + database MySQL sungguhan (khusus test).
//
// KEAMANAN: test MENGHAPUS isi tabel. Karena itu nama database wajib berakhiran "_test"
// (default: <DB_NAME>_test) sehingga data development Anda tidak pernah tersentuh.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { dropAllTables, runMigrations } from '../src/db/migrate.js';
import { createAdminUser } from '../src/services/authService.js';
import { createLogger } from '../src/utils/logger.js';

dotenv.config({ quiet: true });

export const ADMIN_PASSWORD = 'KataSandiUjiCoba-2026';

/** Konfigurasi khusus test (database *_test, bcrypt murah agar cepat, upload ke folder sementara). */
export function testConfig(overrides = {}) {
  const baseName = process.env.DB_NAME || 'royal_bites';
  const dbName = process.env.TEST_DB_NAME || `${baseName.replace(/_test$/, '')}_test`;
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DB_NAME: dbName,
    BCRYPT_COST: '4',
    RATE_LIMIT_ENABLED: 'false',
    LOG_LEVEL: 'silent',
    UPLOAD_DIR: path.join(os.tmpdir(), `royal-bites-test-uploads-${process.pid}`),
    ...overrides,
  });
  if (!/_test$/.test(config.db.database)) {
    throw new Error(`Test menolak berjalan: database "${config.db.database}" harus berakhiran "_test".`);
  }
  return config;
}

/** Menyiapkan database test dari nol (hapus semua tabel lalu jalankan migrasi). */
export async function prepareDatabase(config) {
  await dropAllTables(config.db);
  await runMigrations(config.db);
}

/** Mengosongkan semua data (struktur tabel tetap) di antara test. */
export async function clearData(pool) {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of [
    'payment_notifications',
    'payments',
    'order_events',
    'order_items',
    'orders',
    'admin_sessions',
    'admin_users',
    'products',
    'settings',
    'contact_messages',
  ]) {
    await pool.query(`TRUNCATE TABLE ${table}`);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
}

/** Klien HTTP kecil dengan "cookie jar" + token CSRF otomatis (fetch bawaan Node tidak menyimpan cookie). */
export class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
    this.csrfToken = null;
  }

  async request(method, urlPath, { json, body, headers = {}, csrf = true } = {}) {
    const requestHeaders = { ...headers };
    if (this.cookies.size > 0) {
      requestHeaders.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    if (csrf && this.csrfToken && !['GET', 'HEAD'].includes(method)) {
      requestHeaders['x-csrf-token'] = this.csrfToken;
    }
    let payload = body;
    if (json !== undefined) {
      payload = JSON.stringify(json);
      requestHeaders['content-type'] = 'application/json';
    }
    const response = await fetch(`${this.baseUrl}${urlPath}`, { method, headers: requestHeaders, body: payload });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (/expires=thu, 01 jan 1970/i.test(line) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, data, headers: response.headers, setCookie: response.headers.getSetCookie() };
  }

  get = (p, o) => this.request('GET', p, o);
  post = (p, json, o) => this.request('POST', p, { json, ...o });
  patch = (p, json, o) => this.request('PATCH', p, { json, ...o });
  put = (p, json, o) => this.request('PUT', p, { json, ...o });
  delete = (p, o) => this.request('DELETE', p, o);

  /** Login admin; menyimpan cookie sesi dan token CSRF. */
  async login(username = 'owner', password = ADMIN_PASSWORD) {
    const response = await this.post('/api/admin/login', { username, password });
    if (response.status === 200) this.csrfToken = response.data.csrf_token;
    return response;
  }
}

/** Menyalakan server di port acak. Mengembalikan semua yang dibutuhkan test. */
export async function startTestServer(overrides = {}, { logger = createLogger('silent'), paymentProvider } = {}) {
  const config = testConfig(overrides);
  const pool = createPool(config.db);
  const app = createApp({ config, pool, logger, paymentProvider });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    config,
    pool,
    app,
    paymentService: app.locals.paymentService,
    baseUrl,
    client: () => new Client(baseUrl),
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
      await fs.rm(config.uploads.dir, { recursive: true, force: true });
    },
  };
}

export async function createAdmin(ctx, { username = 'owner', role = 'owner', password = ADMIN_PASSWORD } = {}) {
  return createAdminUser(ctx.pool, ctx.config, { username, password, role });
}

/** Menyisipkan produk langsung ke database. */
export async function insertProduct(pool, overrides = {}) {
  const product = {
    name: `Produk ${crypto.randomBytes(3).toString('hex')}`,
    description: 'Deskripsi uji',
    price: 10000,
    image: null,
    category: 'makanan',
    stock: 0,
    track_stock: 0,
    is_available: 1,
    ...overrides,
  };
  const [result] = await pool.execute(
    `INSERT INTO products (name, description, price, image, category, stock, track_stock, is_available)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      product.name,
      product.description,
      product.price,
      product.image,
      product.category,
      product.stock,
      product.track_stock ? 1 : 0,
      product.is_available ? 1 : 0,
    ],
  );
  return { ...product, id: result.insertId };
}

export async function setSettings(pool, values) {
  for (const [key, value] of Object.entries(values)) {
    const stored = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
    await pool.execute(
      'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
      [key, stored],
    );
  }
}

/** Payload pemesanan yang valid; override untuk menguji kasus lain. */
export function orderPayload(items, overrides = {}) {
  const expectedTotal = items.reduce((sum, item) => sum + (item.price ?? 0) * item.quantity, 0);
  return {
    items: items.map(({ product_id: productId, quantity }) => ({ product_id: productId, quantity })),
    customer_name: 'Budi Santoso',
    customer_phone: '081234567890',
    fulfillment_method: 'pickup',
    payment_method: 'cod',
    expected_total: expectedTotal,
    idempotency_key: crypto.randomUUID(),
    ...overrides,
  };
}

export async function stockOf(pool, productId) {
  const [rows] = await pool.execute('SELECT stock FROM products WHERE id = ?', [productId]);
  return rows[0].stock;
}

export async function countRows(pool, table) {
  const [[row]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return row.n;
}
