# Royal Bites — Website Pemesanan Kuliner (v2)

Website pemesanan makanan untuk UMKM: pelanggan melihat **30 menu** dari database, memasukkan ke keranjang, lalu
checkout dengan **tunai, transfer manual, atau QRIS** lewat payment gateway. Pesanan **tersimpan di MySQL**,
pelanggan bisa **melacak pesanan**, dan pemilik mengelolanya lewat **dashboard admin**.

- **Pelanggan** (`/`): katalog 30 menu (cari, filter kategori, urut harga), keranjang, checkout, formulir kontak.
- **Lacak pesanan** (`/track.html`): status pesanan dan status pembayaran (terpisah), kode QRIS, hitung mundur.
- **Admin** (`/admin/`): login, ringkasan & laporan, pesanan (status, pembayaran, referensi gateway), produk
  (tambah/ubah/sembunyikan/hapus + foto), pesan masuk, pengaturan bisnis.
- **Teknologi**: Node.js 22+, Express 5, MySQL 8, HTML/CSS/JavaScript biasa (tanpa framework frontend).

> **Status jujur — baca sebelum dipakai untuk bisnis sungguhan.** Integrasi QRIS ditulis mengikuti dokumentasi
> resmi Midtrans dan diuji terhadap **server Midtrans tiruan** di komputer pengembang. **Belum pernah diuji dengan
> akun Midtrans sungguhan** (sandbox maupun production) karena kredensial tidak tersedia. Sebelum menerima uang
> sungguhan, lakukan uji sandbox sendiri (bagian [5](#5-pembayaran-qris)) dan baca
> [Hasil pengujian](#9-pengujian) serta [Keterbatasan](#14-keterbatasan-yang-perlu-anda-ketahui).

## Daftar isi

1. [Yang perlu Anda siapkan](#1-yang-perlu-anda-siapkan-windows)
2. [Instalasi langkah demi langkah](#2-instalasi-langkah-demi-langkah)
3. [Katalog 30 menu: mengubah, menambah, mengganti foto](#3-katalog-30-menu)
4. [Cara kerja pemesanan & pelacakan](#4-cara-kerja-pemesanan--pelacakan)
5. [Pembayaran QRIS](#5-pembayaran-qris)
6. [Dashboard admin](#6-dashboard-admin)
7. [Upgrade dari versi 1 & prosedur migrasi/backup yang aman](#7-upgrade-dari-versi-1--migrasi--backup)
8. [Variabel lingkungan (`.env`)](#8-variabel-lingkungan-env)
9. [Pengujian](#9-pengujian)
10. [Deployment (server sungguhan)](#10-deployment-server-sungguhan)
11. [Keamanan (ringkas)](#11-keamanan-ringkas)
12. [Struktur proyek](#12-struktur-proyek)
13. [Pemecahan masalah](#13-pemecahan-masalah)
14. [Keterbatasan yang perlu Anda ketahui](#14-keterbatasan-yang-perlu-anda-ketahui)

---

## 1. Yang perlu Anda siapkan (Windows)

| Kebutuhan | Versi | Catatan |
|---|---|---|
| Node.js | **22 atau lebih baru** (LTS) | https://nodejs.org — installer Windows (.msi). Cek: `node -v` |
| MySQL Community Server | **8.0 atau lebih baru** | https://dev.mysql.com/downloads/installer/ — "Server only" atau "Developer Default". Catat password `root` yang Anda buat saat instalasi. |

> Proyek ini diuji dengan **MySQL 8.0**. MariaDB / paket XAMPP **belum diuji** dan tidak dijamin kompatibel.

Buka **PowerShell** di folder proyek (File Explorer: klik kolom alamat, ketik `powershell`, Enter).

## 2. Instalasi langkah demi langkah

### Langkah 1 — Pasang dependensi

```powershell
npm install
```

### Langkah 2 — Buat database dan user MySQL

```powershell
mysql -u root -p
```

Di prompt `mysql>` jalankan perintah berikut. **Ganti `GANTI_PASSWORD_KUAT` dengan password Anda sendiri.**

```sql
CREATE DATABASE royal_bites CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE royal_bites_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'royalbites_app'@'localhost' IDENTIFIED BY 'GANTI_PASSWORD_KUAT';
CREATE USER 'royalbites_app'@'127.0.0.1' IDENTIFIED BY 'GANTI_PASSWORD_KUAT';
GRANT ALL PRIVILEGES ON royal_bites.* TO 'royalbites_app'@'localhost';
GRANT ALL PRIVILEGES ON royal_bites.* TO 'royalbites_app'@'127.0.0.1';
GRANT ALL PRIVILEGES ON royal_bites_test.* TO 'royalbites_app'@'localhost';
GRANT ALL PRIVILEGES ON royal_bites_test.* TO 'royalbites_app'@'127.0.0.1';
EXIT;
```

`royal_bites_test` hanya dipakai pengujian otomatis (isinya dikosongkan setiap tes berjalan); lewati jika Anda
tidak akan menjalankan tes.

### Langkah 3 — Buat file `.env`

```powershell
copy .env.example .env
```

Buka `.env` dengan Notepad dan isi minimal:

```
DB_USER=royalbites_app
DB_PASSWORD=password yang Anda buat di langkah 2
DB_NAME=royal_bites
```

Biarkan `NODE_ENV=development` untuk laptop. **`.env` berisi rahasia — jangan dikirim ke siapa pun dan jangan
di-upload ke GitHub** (sudah dikecualikan `.gitignore`; ZIP proyek juga tidak memuatnya).
Semua variabel dijelaskan di [bagian 8](#8-variabel-lingkungan-env). QRIS tidak perlu diisi dulu.

### Langkah 4 — Buat tabel (migrasi) dan isi 30 menu

```powershell
npm run migrate
npm run seed:products
```

- `migrate` membuat/mengubah tabel secara **bertahap dan hanya menambah** (tidak menghapus data). Migrasi yang sudah
  berjalan dicatat dan tidak diulang.
- `seed:products` mengisi menu dari `db/seeds/products.json` sampai **tepat 30 menu aktif**. Aman dijalankan
  berulang kali (lihat [bagian 3](#3-katalog-30-menu)).

### Langkah 5 — Buat akun admin pertama (AMAN)

```powershell
npm run admin:create
```

Anda diminta username dan password (**yang diketik tidak tampil**). Aturan password: minimal 12 karakter, bukan
password umum, tidak mengandung username. **Tidak ada akun/password bawaan dan tidak ada pendaftaran admin lewat
web** — satu-satunya cara membuat admin adalah perintah ini di komputer server.

- Akun staf (tidak bisa menghapus produk / mengubah pengaturan): `npm run admin:create -- --role=staff`
- Lupa password: `npm run admin:create -- --reset`

### Langkah 6 — Jalankan

```powershell
npm run dev
```

Buka http://localhost:3000 (situs) dan http://localhost:3000/admin/ (dashboard). Hentikan dengan `Ctrl + C`.

### Langkah 7 — Isi data bisnis Anda

Masuk ke dashboard → **Pengaturan**. Data ini **tidak diisi atau dikarang oleh sistem**; kosong = tidak ditampilkan:

- Nomor WhatsApp bisnis (bagian Kontak dan tombol "Konfirmasi lewat WhatsApp" setelah pesanan)
- Alamat toko, jam operasional, Instagram/Facebook/Twitter
- Pengantaran: aktif atau tidak, area, ongkos kirim (satu tarif tetap)
- Metode pembayaran: tunai, transfer manual (isi nama bank, nomor rekening, atas nama), QRIS (hanya jika gateway sudah dikonfigurasi di server)
- Minimum pemesanan, batas peringatan stok menipis, tombol **Terima pesanan online**
- Logo (opsional)

> **Dua hal yang masih tertulis di `public/index.html` (bukan di Pengaturan):**
> 1. Peta Google Maps di bagian Kontak masih peta dari proyek asli ("Pasar Mega Regency"). Ganti dengan peta toko
>    Anda: Google Maps → Bagikan → *Sematkan peta* → salin `src="..."` ke elemen `<iframe class="map">`.
> 2. Foto & teks "Tentang Kami" masih bawaan proyek asli (foto dari situs pihak ketiga; jika gagal dimuat, otomatis
>    diganti foto lokal). Sesuaikan dengan bisnis Anda.

---

## 3. Katalog 30 menu

**Konsep.** Menu hidup di tabel `products` (database), bukan di HTML. File `db/seeds/products.json` hanyalah
*daftar awal* yang dimasukkan ke database oleh `npm run seed:products`. Setelah itu, **dashboard admin adalah
tempat mengubah menu**; file seed baru dipakai lagi jika Anda ingin menambah menu lewat berkas.

> **Penting — data contoh.** 15 menu pertama berasal dari proyek asli. **15 menu tambahan (beserta harga dan
> deskripsinya) adalah data contoh** supaya katalog berisi 30 menu; **harga dan deskripsinya belum tentu sesuai
> bisnis Anda.** Periksa semuanya di dashboard → Produk sebelum membuka pemesanan. Tidak ada foto yang dikarang:
> hanya 6 menu memiliki foto; 24 menu lain memakai **ilustrasi pengganti per kategori** (`public/images/placeholders/`)
> dengan teks alternatif "foto belum tersedia".

### Aturan seeding (idempoten)

- Menu dicocokkan berdasarkan **nama** (tidak peka huruf besar/kecil). Yang sudah ada **tidak diubah** — harga/deskripsi
  hasil edit Anda aman. Yang belum ada ditambahkan.
- Menjalankan `seed:products` 2, 5, atau 100 kali menghasilkan hasil yang sama: **tetap 30 menu, tanpa duplikat**.
- Menu yang sudah Anda **hapus** di dashboard tidak dimunculkan lagi. Untuk memunculkan kembali:
  `npm run seed:products -- --restore-deleted`.
- Tabel pesanan **tidak disentuh**; riwayat pesanan tetap utuh (nama & harga saat dipesan disimpan di pesanan).
- Menu aktif **tidak boleh punya nama ganda** (dijaga oleh kode dan oleh indeks unik database, migrasi 004).
- Stok awal tidak dihitung (`track_stock = 0`) karena jumlah stok sebenarnya belum diketahui. Aktifkan
  **Hitung stok** per produk di dashboard bila stoknya terbatas.

### Mengganti harga, deskripsi, atau foto

**Lewat dashboard** (disarankan): Admin → **Produk** → Ubah → isi harga/deskripsi → **Unggah foto** (JPG/PNG/WebP,
maks. `UPLOAD_MAX_MB`, isi file diperiksa). Foto tersimpan di folder `uploads/` (ikut di-backup).

**Lewat berkas** (untuk foto bawaan / banyak menu sekaligus):

1. Salin foto ke `public/images/products/` (mis. `nasi-goreng-rempah.jpg`; nama hanya huruf, angka, `.`, `_`, `-`).
2. Di `db/seeds/products.json`, isi `"image": "/images/products/nasi-goreng-rempah.jpg"` pada menu itu
   (`null` = pakai ilustrasi pengganti).
3. Seeding **tidak menimpa** menu yang sudah ada di database (dan `--restore-deleted` hanya memunculkan kembali menu lama
   dengan datanya yang lama). Jadi `products.json` memengaruhi **menu baru** saja; untuk mengganti foto menu yang sudah ada,
   unggah lewat dashboard (Produk → Ubah).

### Menambah menu

Lewat dashboard (Produk → Tambah), atau tambahkan objek baru ke `db/seeds/products.json` (`name`, `description`,
`price` bilangan bulat rupiah, `category` salah satu `makanan|minuman|jajanan|paket`, `image`) lalu
`npm run seed:products`. Skrip memeriksa seluruh berkas (nama ganda, harga, kategori, file foto ada) sebelum
menulis ke database dan melaporkan jumlah ditambahkan/sudah ada.

### Yang tampil di katalog

Kartu menu menampilkan foto/ilustrasi, nama, deskripsi, harga, kategori, status (**Tersedia / Sisa N / Habis /
Tidak tersedia**) dan tombol tambah (nonaktif jika habis/tidak tersedia). Tersedia: pencarian (nama, deskripsi,
kategori), filter kategori, urut **harga termurah / termahal / nama A–Z**, keadaan **memuat / kosong / gagal
dimuat (+ tombol Coba lagi)**, dan tata letak responsif 320–1440 px.

---

## 4. Cara kerja pemesanan & pelacakan

1. Pelanggan memilih menu → keranjang (disimpan di browser; hanya berisi ID menu dan jumlah).
2. Checkout: nama, nomor WhatsApp, ambil sendiri/diantar, metode bayar. Ringkasan (subtotal, ongkir, total)
   ditampilkan sebelum pesanan dikirim.
3. Server **menghitung ulang harga dan memeriksa stok dari database** (harga dari browser tidak pernah dipercaya).
4. Pesanan disimpan dalam satu transaksi; **nomor pesanan** (`RB-yymmdd-XXXXX`) baru tampil setelah server membalas
   bahwa pesanan tersimpan. Klik ganda, refresh, atau koneksi putus **tidak membuat pesanan/pembayaran ganda**
   (kunci idempotensi).
5. **Status pesanan** dan **status pembayaran** adalah dua hal terpisah:

   | Status pesanan | Arti |
   |---|---|
   | Menunggu Konfirmasi → Dikonfirmasi → Sedang Disiapkan → Siap Diambil/Diantar → Selesai | alur normal (hanya maju) |
   | Dibatalkan | dibatalkan admin / pembayaran QRIS tidak dilakukan tepat waktu (stok dikembalikan **sekali**) |

   | Status pembayaran | Arti |
   |---|---|
   | Belum Dibayar | tunai / transfer manual yang belum diterima |
   | Menunggu Pembayaran | QRIS dibuat, belum dibayar |
   | **Lunas (Terverifikasi)** | tunai/transfer: ditandai admin setelah uang diterima · **QRIS: hanya setelah gateway mengonfirmasi** |
   | Pembayaran Gagal / Kedaluwarsa / Dibatalkan | percobaan bayar QRIS tidak berhasil |
   | Dikembalikan | uang dikembalikan (dicatat admin) |

6. **WhatsApp tetap ada** (tombol "Konfirmasi lewat WhatsApp" berisi nomor pesanan & ringkasan), tetapi **membuka
   WhatsApp bukan pembayaran** dan tidak mengubah status apa pun.
7. **Halaman lacak** `/track.html`: dibuka otomatis setelah checkout QRIS lewat tautan berisi **token acak 256-bit**
   di bagian `#fragment` (tidak ikut terkirim ke server/log; dikirim lewat POST). Pelanggan lain/yang kehilangan
   tautan bisa masuk dengan **nomor pesanan + nomor WhatsApp pemesan** (percobaan gagal dibatasi). Tanpa salah
   satunya tidak ada data yang ditampilkan. Halaman memperbarui diri otomatis.

## 5. Pembayaran QRIS

### Konsep (singkat)

QRIS = standar kode QR pembayaran Indonesia. **Kode QR dibuat oleh payment gateway** (di sini Midtrans), bukan oleh
aplikasi ini: server meminta transaksi QRIS ke Midtrans, menerima gambar QR resmi, dan menampilkannya. Aplikasi ini
**tidak pernah membuat QR sendiri dari teks nominal**. Pesanan menjadi **Lunas hanya setelah backend mendapat
konfirmasi dari gateway** — bukan karena klik tombol, bukan karena respons frontend.

```
Pelanggan ──checkout──▶ Server ──charge QRIS──▶ Midtrans
                          │◀──── gambar QR + id transaksi ────┘
Pelanggan ◀── halaman lacak (QR) ──┘      (pelanggan scan & bayar pakai e-wallet/m-banking)
                          │◀─── webhook (notifikasi bertanda tangan) ──── Midtrans
                          └─ verifikasi tanda tangan → cocokkan nominal → tanyakan status ke API Midtrans → LUNAS
```

Perlindungan yang diimplementasikan (dan diuji, terhadap server tiruan):

- **Tanda tangan webhook** SHA-512 (`order_id + status_code + gross_amount + ServerKey`) diperiksa; yang salah → 403, tidak mengubah apa pun.
- **Konfirmasi ulang ke API status Midtrans** sebelum menandai Lunas (menahan notifikasi palsu/diulang).
- **Idempoten**: notifikasi yang sama dikirim berkali-kali tidak mengubah apa pun dan tidak mengembalikan stok dua kali.
- **Nominal & id transaksi dicocokkan**; jika tidak cocok → status tidak berubah dan pesanan diberi tanda "perlu ditinjau".
- Notifikasi **terlambat / tidak berurutan** ditangani (mis. "lunas" yang datang setelah kedaluwarsa tetap dicatat dan ditandai untuk ditinjau admin).
- **Satu pembayaran menunggu per pesanan** dijaga oleh indeks unik database (mencegah pembayaran ganda).
- Referensi gateway (`transaction_id`) tersimpan; admin bisa melihat referensi + waktu pesanan/pembayaran.
- QRIS yang belum dibayar sampai batas waktu (+ jeda) **dibatalkan otomatis** dan stok dikembalikan sekali.
- **Pendapatan di laporan hanya dari pesanan yang benar-benar lunas.** Pesanan menunggu/gagal/kedaluwarsa tidak dihitung.
- Admin **tidak bisa** menandai pesanan QRIS "Lunas" secara manual (hanya gateway); admin hanya bisa menandai
  "Dikembalikan" untuk yang sudah lunas. Pesanan QRIS tidak bisa diproses sebelum lunas.

### Langkah A — Daftar akun merchant Midtrans dan ambil kunci sandbox

1. Daftar di dashboard **Sandbox** Midtrans: https://dashboard.sandbox.midtrans.com/register (akun sandbox gratis, tanpa
   uang sungguhan). Dokumentasi resmi: https://docs.midtrans.com
2. Masuk → pilih environment **Sandbox** → menu **Settings → Access Keys**. Salin **Server Key** (berawalan `SB-`).
3. Tempel di `.env` (**hanya di file ini**; jangan di frontend, Git, atau chat):

   ```
   PAYMENT_PROVIDER=midtrans
   PAYMENT_SERVER_KEY=SB-Mid-server-xxxxxxxxxxxx   (ganti dengan kunci Anda)
   PAYMENT_IS_PRODUCTION=false
   ```

4. Restart server. Di dashboard admin → **Pengaturan**, bagian Pembayaran menampilkan "MODE SANDBOX" beserta URL
   notifikasi yang harus didaftarkan. Opsi QRIS muncul di checkout (dengan pemberitahuan mode sandbox).

> Jika QRIS belum dikonfigurasi, opsi QRIS **tidak ditampilkan sama sekali** dan tunai/transfer tetap berjalan.
> Server menolak start jika `PAYMENT_PROVIDER=midtrans` tetapi kunci kosong, atau kunci sandbox dipakai dengan `PAYMENT_IS_PRODUCTION=true`.

### Langkah B — Daftarkan URL webhook (notifikasi pembayaran)

Midtrans mengirim notifikasi ke URL **publik berhttps**. Daftarkan di dashboard Midtrans → **Settings →
Configuration → Payment Notification URL**:

```
https://DOMAIN-ANDA/api/payments/midtrans/notification
```

Di laptop (`localhost`) Midtrans **tidak bisa** menjangkau server Anda. Dua pilihan:

- **Tunnel sementara** (mis. ngrok atau Cloudflare Tunnel) yang meneruskan `https://xxxx.…` ke `localhost:3000`;
  daftarkan `https://xxxx.…/api/payments/midtrans/notification`, lalu isi `PAYMENT_WEBHOOK_URL` dengan alamat itu
  (hanya untuk ditampilkan di dashboard admin) dan `APP_ORIGIN` bila perlu. Cara memasang tunnel tidak dicakup di sini.
- **Tanpa webhook** (hanya untuk uji): pelanggan menekan **"Saya sudah bayar — cek status"** di halaman lacak, atau admin menekan
  **"Periksa status ke gateway"** di detail pesanan — server menanyakan status langsung ke API Midtrans. Pembatalan otomatis
  juga menanyakan status ke Midtrans sebelum membatalkan. Untuk produksi tetap **wajib memakai webhook**.

### Langkah C — Uji di sandbox (lakukan sendiri sebelum production)

1. Checkout → pilih QRIS → halaman lacak menampilkan kode QR dari Midtrans.
2. Bayar lewat **simulator pembayaran resmi Midtrans** (lihat bagian "Sandbox / Testing" di
   https://docs.midtrans.com; kode QR sandbox tidak bisa dibayar dengan aplikasi bank sungguhan).
3. Pastikan: halaman lacak berubah **Lunas**, dashboard admin menampilkan referensi gateway + waktu bayar, pesanan
   masuk ke pendapatan, dan notifikasi yang dikirim ulang tidak mengubah apa pun.
4. Coba juga: biarkan kedaluwarsa (pesanan harus dibatalkan otomatis, stok kembali) dan bayar dengan nominal berbeda
   bila simulator memungkinkan (harus ditandai "perlu ditinjau", bukan lunas).

Asumsi yang **belum terverifikasi** terhadap Midtrans sungguhan (periksa saat uji sandbox): format kedaluwarsa
(`custom_expiry`), pengambilan gambar QR dari URL aksi tanpa autentikasi, dan nilai `PAYMENT_QRIS_ACQUIRER`.
Jika respons Midtrans berbeda, server mencatat galat di log (tanpa membocorkan kunci) dan menampilkan pesan ramah ke pelanggan.

### Langkah D — Beralih ke production (uang sungguhan)

Lakukan **hanya setelah** Langkah C lolos dan akun merchant Anda disetujui Midtrans (verifikasi bisnis oleh Midtrans;
syarat dan lamanya ditentukan Midtrans, bukan aplikasi ini).

1. Dashboard Midtrans → ganti ke environment **Production** → salin **Server Key production** (tanpa awalan `SB-`).
2. Di `.env` server production:

   ```
   NODE_ENV=production
   PAYMENT_PROVIDER=midtrans
   PAYMENT_SERVER_KEY=kunci production Anda
   PAYMENT_IS_PRODUCTION=true
   APP_ORIGIN=https://domain-anda
   ```

3. Daftarkan Payment Notification URL **production** (berhttps) di dashboard Midtrans production.
4. Restart, buat satu pesanan QRIS kecil sungguhan, bayar, dan pastikan Lunas + dana tercatat di Midtrans.
5. Pastikan **tidak ada** `PAYMENT_PROVIDER=mock` dan `PAYMENT_API_BASE_URL` (keduanya ditolak server di production).

### Mode mock (development, bukan QRIS sungguhan)

Untuk mencoba alur tanpa akun gateway: `PAYMENT_PROVIDER=mock` di `.env` (hanya development).

- Gambar yang tampil berlabel **"MOCK — BUKAN QRIS SAH"**; tidak bisa dipindai/dibayar. Halaman pelanggan dan admin
  menampilkan pemberitahuan "mode uji" yang jelas.
- Simulasikan pembayaran dengan notifikasi bertanda tangan ke webhook lokal Anda:

  ```powershell
  npm run mock:pay -- RB-261021-K7P2M                  # lunas
  npm run mock:pay -- RB-261021-K7P2M --status=expire  # kedaluwarsa (juga: cancel, deny, pending)
  ```

  Server tetap memverifikasi tanda tangan dan nominal seperti di mode sungguhan.
- **Mustahil dipakai di production**: server menolak start dengan `NODE_ENV=production` bila `PAYMENT_PROVIDER=mock`,
  dan skrip `mock:pay` menolak berjalan di production atau bila bukan mode mock.

### Refund dan sengketa

Aplikasi **tidak mengirim refund ke Midtrans**. Refund dilakukan manual di dashboard Midtrans; setelah itu catat di
dashboard admin (detail pesanan → **Catat Sudah Dikembalikan**). Membatalkan pesanan QRIS yang sudah lunas menampilkan peringatan refund
dan Ringkasan menandainya "dibayar tetapi dibatalkan" agar tidak terlewat.

---

## 6. Dashboard admin

- **Ringkasan**: filter rentang tanggal; **nilai pesanan** dipisahkan dari **pendapatan terverifikasi** (hanya yang
  benar-benar lunas); menu terlaris (QRIS yang belum lunas tidak dihitung); rincian per metode/status pembayaran;
  **peringatan stok menipis** (menu yang stoknya dihitung dan ≤ batas di Pengaturan); pesanan yang perlu ditinjau
  (nominal tidak cocok, dibayar tetapi dibatalkan, dll.).
- **Pesanan**: filter status/pembayaran/tanggal/pencarian; kolom status pesanan, **status pembayaran**, **referensi
  gateway**, waktu pesanan, dan waktu pembayaran; detail + riwayat; tombol **Periksa status ke gateway** untuk QRIS.
- **Produk**: tambah/ubah/sembunyikan/hapus (hapus lunak; riwayat pesanan aman), unggah foto, filter status,
  penanda stok menipis, ilustrasi pengganti jika belum ada foto.
- **Pengaturan** (owner): data bisnis, pengantaran, metode bayar. Konfigurasi QRIS tampil **baca-saja** (mode, URL
  webhook, kedaluwarsa) **tanpa kunci rahasia**; kunci hanya diubah di `.env` server.
- Peran: **owner** (semua) dan **staff** (tanpa hapus produk & pengaturan). Semua endpoint admin butuh login.

## 7. Upgrade dari versi 1 & migrasi / backup

Migrasi v2 (`003_qris_payments.sql`, `004_unique_active_product_name.sql`) **hanya menambah** tabel/kolom/indeks:
tidak ada `DROP`, `TRUNCATE`, atau penghapusan data. Pesanan lama tetap utuh (status, item, total tidak berubah) dan
tidak diberi data pembayaran palsu.

**Prosedur aman:**

1. **Backup dulu** (database + folder `uploads/`). Di PowerShell pakai `--result-file` (operator `>` di Windows
   PowerShell 5 menyimpan UTF-16 sehingga berkas tidak bisa dipulihkan):

   ```powershell
   mysqldump -u root -p --single-transaction --routines --no-tablespaces --result-file=backups\royal_bites-SEBELUM-V2.sql royal_bites
   ```

2. Hentikan server, salin kode v2 (jangan menimpa `.env` dan `uploads/`), lalu `npm ci --omit=dev` (atau `npm install`).
3. `npm run migrate` — menjalankan hanya migrasi yang belum tercatat.
   - Jika database Anda **sudah berisi nama menu aktif yang ganda**, migrasi 004 **tidak membuat indeks unik** dan mencetak
     `PERINGATAN`. Data tidak diubah. Rapikan duplikatnya di dashboard (ubah nama atau hapus salah satu), lalu jalankan
     `ALTER TABLE products ADD UNIQUE KEY uq_products_active_name (active_name);`.
4. `npm run seed:products` (opsional; menambah menu yang belum ada tanpa menimpa yang ada).
5. Jalankan server, cek `http://localhost:3000/api/health` dan buka dashboard.

**Pulihkan jika perlu** (ke database kosong; di dalam prompt `mysql>` atau dengan `-e`):

```powershell
mysql -u root -p royal_bites -e "source backups/royal_bites-SEBELUM-V2.sql"
```

> Perintah backup/restore di atas sudah dicoba di Linux (MySQL 8.0.46) terhadap database uji; **belum dicoba di Windows**.
> Berkas backup berisi data pelanggan: simpan di tempat aman. Folder `backups/` dikecualikan dari Git dan ZIP.

Verifikasi migrasi (manual, sekali): database v1 berisi produk + pesanan lunas dimigrasi ke v2 — pesanan, item,
dan status tetap sama, jumlah produk tidak berubah, indeks unik terbentuk saat tidak ada duplikat, dan saat ada
duplikat (`Nasi Kentut` / `nasi kentut`) migrasi tetap berhasil dengan peringatan dan tanpa kehilangan data.

## 8. Variabel lingkungan (`.env`)

Contoh lengkap dan komentarnya ada di `.env.example` (tanpa nilai rahasia). Ringkasan:

| Variabel | Default | Keterangan |
|---|---|---|
| `NODE_ENV` | `development` | `production` saat deploy (mengaktifkan pemeriksaan keamanan ketat) |
| `PORT`, `HOST` | `3000`, loopback/`0.0.0.0` | alamat server |
| `TRUST_PROXY` | kosong | jumlah reverse proxy di depan server (mis. `1`) |
| `APP_ORIGIN`, `CORS_ORIGINS` | kosong | alamat resmi situs / domain frontend terpisah |
| `FORCE_HTTPS` | `false` | alihkan http → https |
| `DB_HOST/PORT/USER/PASSWORD/NAME` | — | koneksi MySQL (`DB_PASSWORD` wajib di production) |
| `SESSION_TTL_HOURS`, `SESSION_IDLE_MINUTES`, `COOKIE_SECURE`, `BCRYPT_COST` | 8, 120, otomatis, 12 | sesi admin |
| `UPLOAD_DIR`, `UPLOAD_MAX_MB` | `./uploads`, 2 | foto unggahan |
| `BUSINESS_UTC_OFFSET_MINUTES` | 420 | zona waktu laporan (WIB 420, WITA 480, WIT 540) |
| `PAYMENT_PROVIDER` | kosong | kosong = QRIS nonaktif · `midtrans` · `mock` (tidak untuk production) |
| `PAYMENT_SERVER_KEY` | kosong | **RAHASIA.** Server Key Midtrans; hanya di server |
| `PAYMENT_IS_PRODUCTION` | `false` | `true` hanya untuk kunci production |
| `PAYMENT_WEBHOOK_URL` | kosong | URL notifikasi (ditampilkan di dashboard admin; didaftarkan di Midtrans) |
| `PAYMENT_QRIS_EXPIRY_MINUTES` | 15 | batas waktu bayar (5–1440) |
| `PAYMENT_EXPIRY_GRACE_SECONDS` | 90 | jeda sebelum pembatalan otomatis |
| `PAYMENT_SWEEP_INTERVAL_SECONDS` | 60 | frekuensi pemeriksaan kedaluwarsa |
| `PAYMENT_VERIFY_STATUS_API` | `true` | konfirmasi "lunas" ke API gateway (jangan dimatikan) |
| `PAYMENT_QRIS_ACQUIRER`, `PAYMENT_CLIENT_KEY`, `PAYMENT_MERCHANT_ID`, `PAYMENT_REQUEST_TIMEOUT_MS` | `gopay`, kosong, kosong, 10000 | opsional |

`PAYMENT_API_BASE_URL` hanya untuk pengujian otomatis dan ditolak di production. Jangan pernah menaruh kunci/password
di `public/`, kode frontend, Git, atau ZIP.

## 9. Pengujian

```powershell
npm run check       # pemeriksaan sintaks seluruh file JavaScript
npm test            # tes backend: unit + integrasi dengan MySQL sungguhan (database royal_bites_test)
npm run test:e2e    # tes browser (opsional; butuh Playwright + Chromium)
```

Tes memakai database khusus `royal_bites_test` (nama harus berakhiran `_test`; isinya dikosongkan setiap tes
berjalan — data asli Anda aman) dan **server Midtrans tiruan lokal** (`test/fakeMidtrans.js`). Tes browser:

```powershell
npm install --no-save playwright
npx playwright install chromium
npm run test:e2e                 # semua kelompok
npm run test:e2e -- --only=qris  # satu/beberapa kelompok: customer, admin, qris, admin-qris, catalog
```

Tes lama (v1) tidak dinonaktifkan; satu di antaranya dilonggarkan karena secara statistik tidak stabil (lihat bawah).

### Hasil pengujian

Dijalankan di Linux, Node 22, **MySQL 8.0.46**, Chromium (Playwright). Angka di bawah adalah hasil lari nyata terakhir:

| Perintah | Hasil |
|---|---|
| `npm run check` | **64 dari 64** file JavaScript lolos pemeriksaan sintaks |
| `npm test` | **271 dari 271 lulus** (102 unit + 169 integrasi dengan MySQL sungguhan). Termasuk 164 tes versi 1 yang tidak dinonaktifkan |
| `npm run test:e2e` | **46 dari 46 skenario lulus**, dijalankan dua kali berturut-turut dengan hasil sama |

Rincian tes browser (Chromium, viewport 320–1440 px): **Pelanggan 14** (katalog dari database, pencarian & filter, keranjang,
checkout tersimpan di MySQL, harga dimanipulasi, stok kurang, klik berulang, koneksi putus, kontak, responsif) ·
**Admin 12** (akses tanpa login ditolak, login/logout, status & pembayaran, pembatalan + stok, CRUD produk + foto,
peran staf, pengaturan, pesan, ubah password) · **QRIS & lacak 8** (checkout QRIS di layar HP 390 px menampilkan QR dari
gateway tiruan; muat ulang tidak menggandakan pesanan/pembayaran; lunas lewat webhook valid; browser tidak bisa membuat
status lunas; gateway gagal; kedaluwarsa; akses lacak; metode lama tetap jalan; tanpa kredensial QRIS tidak ditawarkan) ·
**Admin pembayaran 5** (referensi gateway & waktu, QRIS tidak bisa ditandai lunas manual, pendapatan hanya dari yang lunas,
peringatan refund, stok menipis, konfigurasi QRIS baca-saja) · **Katalog 7** (tepat 30 menu tanpa duplikat dan tetap 30
setelah seed diulang, urut harga, filter & pencarian, 30 gambar termuat dengan ilustrasi pengganti, indikator
Habis/Sisa/Tidak tersedia, keadaan memuat/kosong/gagal + Coba lagi, tanpa geser horizontal).

Tes backend baru mencakup antara lain: seed tepat 30 & tidak ganda saat diulang, pencarian/filter katalog, validasi harga/stok,
checkout berhasil/gagal, QRIS pending, webhook lunas yang valid, tanda tangan salah, webhook berulang, kedaluwarsa/gagal,
nominal tidak cocok, pembayaran ganda dicegah, stok tidak dikurangi/dikembalikan dua kali, otorisasi admin, dan metode
pembayaran lama tetap berfungsi.

**Diperiksa manual (bukan tes otomatis):** migrasi v1 → v2 pada database berisi data (dengan dan tanpa nama menu ganda);
server mode mock dijalankan sebagai proses sungguhan + `npm run mock:pay` (lunas, kirim ulang, tanda tangan salah 403,
penolakan di production); perintah backup & restore; tampilan 320 px dengan nama usaha sangat panjang (tangkapan layar).

**Hal yang perlu diketahui tentang tes:**

- Gateway di semua tes adalah **server Midtrans tiruan**; "gambar QR"-nya hanya PNG 1×1. Tes membuktikan alur halaman +
  backend + kontrak dokumentasi, **bukan** bahwa akun Midtrans sungguhan menerima pembayaran atau bahwa kode QR bisa dipindai.
- Satu tes versi 1 ("nomor pesanan tidak berulang pada 2000 percobaan") secara statistik tidak stabil; batasnya dilonggarkan
  (≥ 1990 unik, dengan komentar) dan ditambah tes tabrakan nomor yang deterministik.
- Pembuatan tes browser menemukan dua hal: kondisi balapan pada tes (membaca layar sebelum penghapusan item keranjang selesai)
  yang sudah diperbaiki di tes, dan **bug tampilan nyata**: judul hero meluber di layar 320 px bila nama usaha lebih panjang
  dari "Royal Bites" — sudah diperbaiki di aplikasi (judul boleh turun baris; teks logo header dipotong maksimal 2 baris).
- Tes browser menjalankan `catalog` paling akhir karena ia menyembunyikan menu uji milik kelompok lain lalu memuat 30 menu seed.
- Internet luar diblokir di lingkungan uji (font Google, peta Google, foto kumparan.com); tampilan memakai fallback lokal.

## 10. Deployment (server sungguhan)

Jalankan dengan `NODE_ENV=production` di belakang **HTTPS** (Nginx/Caddy, Cloudflare, atau PaaS).

1. Server dengan Node 22+ dan MySQL 8. Salin proyek (tanpa `node_modules` dan `.env`), lalu `npm ci --omit=dev`.
2. Buat database + user MySQL **khusus aplikasi** dengan password kuat (bukan `root`).
3. Buat `.env` di server: `NODE_ENV=production`, `DB_PASSWORD`, `TRUST_PROXY=1` (bila di belakang satu proxy),
   `APP_ORIGIN=https://domain-anda`, `BUSINESS_UTC_OFFSET_MINUTES`. Untuk QRIS lihat [bagian 5](#5-pembayaran-qris).
4. **Backup database**, lalu `npm run migrate`, `npm run seed:products` (opsional), `npm run admin:create`.
5. `npm start`. Gunakan pengelola proses agar hidup kembali otomatis: **pm2** / **systemd** (Linux), **NSSM** (Windows).
6. Pastikan `uploads/` tidak hilang saat deploy ulang dan ikut di-backup.
7. **QRIS production**: URL webhook berhttps yang dapat dijangkau internet, terdaftar di dashboard Midtrans. Jalankan **satu**
   proses server (pembatalan otomatis QRIS dan pembatas request berjalan di dalam proses; menjalankan beberapa proses
   belum diuji).

Update versi baru: backup → salin kode → `npm ci --omit=dev` → `npm run migrate` → restart.

> `npm start` menolak berjalan jika `DB_PASSWORD` kosong, cookie aman dimatikan, pembatas request dimatikan, atau
> konfigurasi pembayaran tidak aman (mock di production, kunci sandbox bertanda production). Itu disengaja. Untuk
> mencoba di laptop gunakan `npm run dev`.

## 11. Keamanan (ringkas)

- Harga, total, dan stok **selalu dihitung server dari database**; query berparameter (anti SQL injection).
- Input divalidasi di server (zod); tampilan dibuat dengan DOM API, bukan `innerHTML`; CSP ketat tanpa skrip/gaya inline.
- Login admin: bcrypt, sesi acak di cookie `HttpOnly` + `SameSite=Strict` (+`Secure` di production), token CSRF
  untuk semua perubahan data, pembatasan percobaan login, batas waktu sesi. Tidak ada admin/password bawaan.
- Rahasia (password DB, Server Key) hanya di `.env` server, tidak pernah dikirim ke browser dan tidak masuk ZIP/Git.
- Webhook: tanda tangan + nominal + konfirmasi API status. Token lacak acak 256-bit dikirim lewat POST (tidak masuk URL/log server);
  di database ia tersimpan apa adanya (kolom `public_token`), jadi siapa pun yang bisa membaca database dapat melacak pesanan — sama
  sensitifnya dengan data pesanan itu sendiri.
- Pesan error ke pengguna tidak membocorkan detail database/gateway.

## 12. Struktur proyek

```
src/            server Express (routes, services, payments, middleware, config)
src/payments/   penyedia pembayaran: midtrans, mock, tanda tangan webhook
public/         situs pelanggan (index.html, track.html, css/, js/, images/) dan dashboard admin (admin/)
db/migrations/  skema database (npm run migrate) — 001..004
db/seeds/       products.json (30 menu)
scripts/        migrate, seed-products, create-admin, mock-pay, start, check-syntax
test/           unit, integrasi (npm test), e2e browser (npm run test:e2e), fakeMidtrans.js
docs/API.md     daftar endpoint API
uploads/        foto unggahan admin (di luar Git)
```

## 13. Pemecahan masalah

| Gejala | Penyebab & solusi |
|---|---|
| `Tidak dapat terhubung ke database MySQL` | MySQL belum berjalan (Services → MySQL80 → Start) atau `.env` salah. |
| `Access denied for user` | Password di `.env` tidak sama dengan user MySQL, atau `GRANT` di Langkah 2 belum dijalankan. |
| `Unknown database 'royal_bites'` | Database belum dibuat (Langkah 2). |
| `Migrasi gagal` | User perlu hak pada database itu; perbaiki lalu jalankan ulang `npm run migrate`. |
| Migrasi mencetak `PERINGATAN … nama menu aktif ganda` | Rapikan nama ganda di dashboard lalu buat indeks unik (lihat bagian 7). |
| Menu kurang dari 30 | Jalankan `npm run seed:products`; menu yang pernah dihapus: tambahkan `-- --restore-deleted`. |
| Menu tidak muncul / "Menu belum bisa dimuat" | Server/database bermasalah: lihat terminal; cek http://localhost:3000/api/health. |
| Opsi QRIS tidak muncul di checkout | `PAYMENT_PROVIDER` kosong, atau "Terima QRIS" dimatikan di Pengaturan. |
| Server tidak mau start: `PAYMENT_SERVER_KEY wajib diisi` | `PAYMENT_PROVIDER=midtrans` butuh Server Key; kosongkan provider jika tidak memakai QRIS. |
| `PAYMENT_PROVIDER=mock ... DILARANG di production` | Mock hanya development. Pakai `midtrans`. |
| QRIS tampil "Gagal membuat kode" | Kunci salah/Midtrans tak terjangkau: lihat log server; pelanggan bisa menekan "Buat Kode QRIS Baru" di halaman lacak (tidak menggandakan transaksi). |
| Sudah bayar di sandbox tetapi masih "Menunggu" | Webhook belum terdaftar/terjangkau (localhost): tekan "Saya sudah bayar — cek status", atau daftarkan URL publik (Langkah B). |
| Notifikasi ditolak 403 | Server Key di `.env` tidak sama dengan yang dipakai Midtrans (sandbox vs production tertukar). |
| Pesanan QRIS berstatus "perlu ditinjau" | Nominal/transaksi tidak cocok atau pembayaran datang terlambat: periksa di dashboard Midtrans, lalu tindak lanjuti manual. |
| `npm start` langsung berhenti dengan pesan konfigurasi | Mode production butuh `DB_PASSWORD` dan HTTPS. Di laptop pakai `npm run dev`. |
| `EADDRINUSE` | Port dipakai program lain: ubah `PORT` di `.env`. |
| Login admin terus gagal | `npm run admin:create -- --reset`. Setelah 10 kali gagal, IP diblokir sementara 15 menit. |
| Foto tidak bisa diunggah | Hanya JPG/PNG/WebP, maksimal `UPLOAD_MAX_MB` (default 2 MB). |
| `npm run test:e2e` gagal memuat Playwright | `npm install --no-save playwright` lalu `npx playwright install chromium`. |

## 14. Keterbatasan yang perlu Anda ketahui

- **QRIS belum diuji dengan Midtrans sungguhan** (sandbox maupun production). Yang diuji: seluruh alur terhadap server
  tiruan yang meniru kontrak dokumentasi resmi. "Gambar QR" dari server tiruan hanya PNG 1×1 (bukan kode yang bisa dipindai).
  Kebenaran nyata baru terbukti setelah Anda menjalankan uji sandbox (Langkah C) lalu satu transaksi production kecil (Langkah D).
- Hanya **Midtrans** yang didukung; gateway lain butuh penyedia baru di `src/payments/`.
- **Refund** dilakukan manual di dashboard Midtrans; aplikasi hanya mencatatnya.
- **Tidak ada notifikasi otomatis ke pemilik** (email/WhatsApp). Pesanan baru ditandai di dashboard.
- **Harga & deskripsi 24 menu tanpa foto, dan 15 menu tambahan, adalah data contoh**; sesuaikan dengan bisnis Anda.
  Foto tidak dikarang: menu tanpa foto memakai ilustrasi pengganti.
- Ongkos kirim satu tarif tetap; tidak ada diskon/voucher.
- Pembatas request disimpan di memori satu proses; beberapa server butuh penyimpanan bersama.
- Peta Google dan foto "Tentang Kami" masih bawaan proyek asli (Langkah 7).
- **Belum diuji**: berjalan langsung di **Windows**; **MariaDB/XAMPP**; browser selain Chromium (Firefox/Safari); pembaca layar;
  deployment HTTPS sungguhan; beban banyak pengunjung; font Google, peta Google, dan tombol WhatsApp di perangkat nyata
  (internet luar diblokir di lingkungan uji).
- Aplikasi **belum dapat dinyatakan "siap produksi"** sebelum uji sandbox/production QRIS, pengisian data bisnis asli, dan
  pemeriksaan deployment HTTPS oleh Anda.

Dokumentasi endpoint: [docs/API.md](docs/API.md).
