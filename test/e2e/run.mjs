// Menjalankan seluruh pengujian browser:  npm run test:e2e   (lihat harness.mjs untuk prasyarat)
import { createRunner, loadPlaywright, startE2EServer } from './harness.mjs';
import { runCustomerScenarios } from './customer.mjs';
import { runQrisScenarios } from './qris.mjs';
import { runAdminPaymentScenarios } from './admin-payments.mjs';
import { runCatalogScenarios } from './catalog.mjs';

// --only=customer,admin  (daftar dipisah koma). Tanpa opsi: semua kelompok dijalankan berurutan.
const onlyList = process.argv.find((arg) => arg.startsWith('--only='))?.split('=')[1]?.split(',');
const wants = (group) => !onlyList || onlyList.includes(group);

const { chromium } = loadPlaywright();
const launchOptions = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(launchOptions);
const server = await startE2EServer();
const runner = createRunner();

try {
  if (wants('customer')) {
    console.log('\n== Pelanggan ==');
    await runCustomerScenarios({ browser, server, runner });
  }
  if (wants('admin')) {
    const { runAdminScenarios } = await import('./admin.mjs').catch(() => ({}));
    if (runAdminScenarios) {
      console.log('\n== Admin ==');
      await runAdminScenarios({ browser, server, runner });
    }
  }
  if (wants('qris')) {
    console.log('\n== QRIS & lacak pesanan ==');
    await runQrisScenarios({ browser, server, runner });
  }
  if (wants('admin-qris')) {
    console.log('\n== Admin: pembayaran, laporan, stok ==');
    await runAdminPaymentScenarios({ browser, server, runner });
  }
  // Paling akhir: skenario ini menyembunyikan menu uji lain lalu memuat 30 menu seed.
  if (wants('catalog')) {
    console.log('\n== Katalog 30 menu ==');
    await runCatalogScenarios({ browser, server, runner });
  }
} finally {
  await browser.close();
  await server.stop();
}
process.exit(runner.summary());
