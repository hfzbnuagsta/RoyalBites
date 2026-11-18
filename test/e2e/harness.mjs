// Pengujian end-to-end DI BROWSER SUNGGUHAN (Chromium via Playwright) + server + MySQL sungguhan.
//
// Ini TIDAK ikut `npm test` karena butuh Playwright dan browser. Cara menjalankan (opsional):
//   npm install --no-save playwright
//   npx playwright install chromium
//   npm run test:e2e
//
// Seperti test lainnya, skrip ini memakai database khusus "<DB_NAME>_test" (dikosongkan setiap kali dijalankan),
// jadi data development Anda tidak tersentuh.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createApp } from '../../src/app.js';
import { createPool } from '../../src/db/pool.js';
import { createAdminUser } from '../../src/services/authService.js';
import { ADMIN_PASSWORD, prepareDatabase, testConfig } from '../helpers.js';
import { FAKE_SERVER_KEY, startFakeMidtrans } from '../fakeMidtrans.js';
import { createLogger } from '../../src/utils/logger.js';

/** Memuat Playwright dari proyek ini, atau dari lokasi lain jika PLAYWRIGHT_DIR diatur. */
export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    if (process.env.PLAYWRIGHT_DIR) return createRequire(`${process.env.PLAYWRIGHT_DIR.replace(/\/?$/, '/')}`)('playwright');
    throw new Error('Playwright belum terpasang. Jalankan: npm install --no-save playwright && npx playwright install chromium');
  }
}

/** Menyiapkan DB test, data contoh, dan menyalakan server. */
export async function startE2EServer() {
  const config = testConfig({ RATE_LIMIT_ENABLED: 'false' });
  await prepareDatabase(config);
  const pool = createPool(config.db);

  await createAdminUser(pool, config, { username: 'pemilik', password: ADMIN_PASSWORD, role: 'owner' });
  await createAdminUser(pool, config, { username: 'kasir', password: ADMIN_PASSWORD, role: 'staff' });

  // Data uji (hanya ada di database *_test).
  const products = [
    ['Nasi Uji', 'Nasi untuk pengujian harga.', 20000, 'makanan', 0, 0, 1],
    ['Es Terbatas', 'Stok dihitung: hanya 3.', 5000, 'minuman', 3, 1, 1],
    ['Menu Habis', 'Stok dihitung: 0.', 7000, 'jajanan', 0, 1, 1],
    ['Kue Nonaktif', 'Ditandai tidak tersedia.', 3000, 'jajanan', 0, 0, 0],
  ];
  for (const [name, description, price, category, stock, trackStock, isAvailable] of products) {
    await pool.execute(
      'INSERT INTO products (name, description, price, category, stock, track_stock, is_available) VALUES (?,?,?,?,?,?,?)',
      [name, description, price, category, stock, trackStock, isAvailable],
    );
  }
  // Pengaturan uji (nomor ini HANYA untuk database test; bukan data bisnis nyata).
  const settings = {
    whatsapp_number: '6281200000000',
    delivery_enabled: '1',
    delivery_fee: '5000',
    delivery_area: 'Area uji',
    payment_transfer_enabled: '1',
    payment_transfer_instructions: 'Bank Uji 000-000 a.n. Pengujian',
  };
  for (const [key, value] of Object.entries(settings)) {
    await pool.execute('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
  }

  const listen = (app) =>
    new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

  // Server UTAMA: tanpa gateway pembayaran (metode lama saja), seperti instalasi tanpa kredensial.
  const app = createApp({ config, pool, logger: createLogger('silent') });
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Server KEDUA (database yang sama) dengan QRIS memakai server Midtrans TIRUAN lokal (test/fakeMidtrans.js).
  // Ini bukan Midtrans sungguhan: yang diuji adalah alur halaman + backend terhadap kontrak yang terdokumentasi.
  const fake = await startFakeMidtrans();
  const qrisConfig = testConfig({
    RATE_LIMIT_ENABLED: 'false',
    PAYMENT_PROVIDER: 'midtrans',
    PAYMENT_SERVER_KEY: FAKE_SERVER_KEY,
    PAYMENT_API_BASE_URL: fake.baseUrl,
    PAYMENT_QRIS_EXPIRY_MINUTES: '15',
  });
  const qrisApp = createApp({ config: qrisConfig, pool, logger: createLogger('silent') });
  const qrisServer = await listen(qrisApp);
  const qris = {
    baseUrl: `http://127.0.0.1:${qrisServer.address().port}`,
    fake,
    paymentService: qrisApp.locals.paymentService,
    /** Mengirim notifikasi bertanda tangan seperti yang dikirim gateway (tanpa mengubah status di server tiruan). */
    notify: (body) =>
      fetch(`http://127.0.0.1:${qrisServer.address().port}/api/payments/midtrans/notification`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };

  return {
    config,
    pool,
    baseUrl,
    qris,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => qrisServer.close(resolve));
      await fake.stop();
      await pool.end();
      await fs.rm(config.uploads.dir, { recursive: true, force: true });
    },
  };
}

/** Pencatat hasil: setiap skenario dijalankan terpisah, kegagalan satu tidak menghentikan yang lain. */
export function createRunner() {
  const results = [];
  return {
    results,
    async scenario(name, fn) {
      const started = Date.now();
      try {
        await fn();
        results.push({ name, ok: true });
        console.log(`  LULUS  ${name} (${Date.now() - started} ms)`);
      } catch (error) {
        results.push({ name, ok: false, error });
        console.log(`  GAGAL  ${name}\n         ${String(error.message).split('\n').join('\n         ')}`);
      }
    },
    summary() {
      const failed = results.filter((result) => !result.ok);
      console.log(`\nHasil: ${results.length - failed.length}/${results.length} skenario lulus.`);
      return failed.length === 0 ? 0 : 1;
    },
  };
}
