// Menjalankan migrasi database:  npm run migrate
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
import { loadConfig, assertRunnable } from '../src/config/env.js';
import { runMigrations } from '../src/db/migrate.js';

try {
  const config = loadConfig();
  assertRunnable(config);
  const result = await runMigrations(config.db, { log: (msg) => console.log(msg) });
  if (result.applied.length === 0) {
    console.log('Database sudah mutakhir. Tidak ada migrasi baru.');
  } else {
    console.log(`Selesai. ${result.applied.length} migrasi dijalankan.`);
  }
} catch (error) {
  // Tampilkan pesan singkat tanpa membocorkan password dari konfigurasi.
  console.error(`Migrasi gagal: ${error.sqlMessage || error.message}`);
  process.exitCode = 1;
}
