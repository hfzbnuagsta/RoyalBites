// Runner migrasi sederhana: menjalankan file db/migrations/*.sql secara berurutan,
// sekali saja per file, dan mencatatnya di tabel schema_migrations.
//
// Catatan: DDL di MySQL (CREATE/ALTER TABLE) otomatis commit, jadi satu file migrasi
// tidak bisa di-rollback sebagian. Karena itu setiap file dibuat kecil dan fokus.
import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { PROJECT_ROOT } from '../config/env.js';

const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'db', 'migrations');

/** Mengambil teks dari kolom `peringatan` pada hasil multi-statement (hasil perintah lain diabaikan). */
function collectWarnings(results) {
  const sets = Array.isArray(results) && results.some(Array.isArray) ? results : [results];
  return sets
    .filter(Array.isArray)
    .flat()
    .filter((row) => row && typeof row === 'object' && typeof row.peringatan === 'string')
    .map((row) => row.peringatan);
}

export async function runMigrations(dbConfig, { log = () => {} } = {}) {
  // Koneksi khusus dengan multipleStatements karena file SQL berisi banyak perintah.
  // Hanya dipakai untuk file migrasi milik proyek ini (bukan input pengguna).
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    multipleStatements: true,
    charset: 'utf8mb4',
  });

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [appliedRows] = await connection.query('SELECT name FROM schema_migrations');
    const applied = new Set(appliedRows.map((row) => row.name));

    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
    const newlyApplied = [];

    for (const file of files) {
      if (applied.has(file)) continue;
      log(`Menjalankan migrasi ${file} ...`);
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const [results] = await connection.query(sql);
      // Migrasi boleh mengembalikan baris `peringatan` (mis. 004 saat ada nama menu ganda); tampilkan agar tidak terlewat.
      for (const warning of collectWarnings(results)) log(`${file}: ${warning.replace(/^PERINGATAN:\s*/, 'PERINGATAN — ')}`);
      await connection.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      newlyApplied.push(file);
    }

    return { applied: newlyApplied, total: files.length };
  } finally {
    await connection.end();
  }
}

/** Menghapus SEMUA tabel di database. Hanya untuk database test. */
export async function dropAllTables(dbConfig) {
  if (!/_test$/.test(dbConfig.database)) {
    throw new Error(`Menolak menghapus tabel: nama database "${dbConfig.database}" tidak berakhiran "_test".`);
  }
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
  });
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    const [tables] = await connection.query(
      'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?',
      [dbConfig.database],
    );
    for (const { name } of tables) {
      await connection.query(`DROP TABLE IF EXISTS \`${name}\``);
    }
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await connection.end();
  }
}
