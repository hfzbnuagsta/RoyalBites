// Koneksi MySQL. Semua query aplikasi memakai parameter (?) sehingga aman dari SQL injection.
import mysql from 'mysql2/promise';

export function createPool(dbConfig) {
  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    connectionLimit: dbConfig.connectionLimit,
    waitForConnections: true,
    connectTimeout: 5000, // gagal cepat (5 dtk) jika database tidak bisa dijangkau
    charset: 'utf8mb4',
    // Waktu disimpan & dibaca sebagai UTC. Konversi ke WIB dilakukan di aplikasi/frontend.
    timezone: 'Z',
    // SUM() pada MySQL menghasilkan DECIMAL; opsi ini mengubahnya menjadi number biasa.
    decimalNumbers: true,
    multipleStatements: false,
  });

  // Setiap koneksi baru memakai zona waktu UTC supaya CURRENT_TIMESTAMP konsisten.
  pool.pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });

  return pool;
}

/**
 * Menjalankan fungsi di dalam transaksi. Otomatis commit jika sukses dan rollback jika error.
 * Jika MySQL membatalkan transaksi karena deadlock (jarang terjadi), transaksi diulang otomatis.
 */
export async function withTransaction(pool, work, { deadlockRetries = 2 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // Abaikan: koneksi mungkin sudah putus. Error asli lebih penting.
      }
      if (error.code === 'ER_LOCK_DEADLOCK' && attempt < deadlockRetries) continue;
      throw error;
    } finally {
      connection.release();
    }
  }
}
