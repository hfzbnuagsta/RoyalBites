// Titik masuk server:  npm start  (atau  npm run dev  saat pengembangan)
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
import { createApp } from './app.js';
import { assertRunnable, loadConfig } from './config/env.js';
import { createPool } from './db/pool.js';
import { createLogger, serializeError } from './utils/logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

try {
  assertRunnable(config);
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}

const pool = createPool(config.db);

// Periksa koneksi database saat start supaya salah konfigurasi langsung terlihat.
try {
  await pool.query('SELECT 1');
} catch (error) {
  logger.error('database_unreachable', { error: serializeError(error) });
  console.error(
    '\nTidak dapat terhubung ke database MySQL. Periksa DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME di file .env,\n' +
      'dan pastikan MySQL sudah berjalan serta migrasi sudah dijalankan (npm run migrate).\n',
  );
  process.exit(1);
}

const app = createApp({ config, pool, logger });
const paymentService = app.locals.paymentService;
if (paymentService.isAvailable()) {
  const { provider } = paymentService;
  logger.info('payment_enabled', { provider: provider.name, mode: provider.mode });
  if (provider.mode === 'mock') console.warn('PERINGATAN: PAYMENT_PROVIDER=mock aktif. Ini hanya mode uji, BUKAN pembayaran sungguhan.');
  if (provider.mode === 'sandbox') console.warn('Catatan: pembayaran QRIS memakai SANDBOX (uji coba). Uang sungguhan tidak diproses.');
}
// Pembatalan otomatis pesanan QRIS yang tidak dibayar sampai batas waktu.
const stopSweeper = paymentService.startSweeper();
const server = app.listen(config.port, config.host, () => {
  logger.info('server_started', { host: config.host, port: config.port, env: config.nodeEnv });
  console.log(`Royal Bites berjalan di http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
});

// Matikan dengan rapi (selesaikan request yang sedang berjalan) saat menerima sinyal stop.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown', { signal });
  stopSweeper();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { error: serializeError(reason) });
});
