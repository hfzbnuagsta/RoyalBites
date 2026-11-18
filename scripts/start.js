// Menjalankan server dalam mode production:  npm start
//
// Dibuat sebagai skrip Node (bukan "NODE_ENV=production node ..." di package.json) karena sintaks itu
// hanya berjalan di Linux/macOS dan GAGAL di Windows (cmd/PowerShell). Skrip ini bekerja di semua sistem.
//
// Catatan: mode production mewajibkan DB_PASSWORD terisi dan cookie sesi "Secure" (HTTPS).
// Untuk mencoba di laptop tanpa HTTPS, gunakan:  npm run dev
process.env.NODE_ENV ??= 'production';
await import('../src/server.js');
