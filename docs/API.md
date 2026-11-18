# Dokumentasi API Royal Bites

Semua respons berupa JSON. Error selalu berbentuk:

```json
{ "error": { "code": "KODE_ERROR", "message": "Pesan untuk pengguna", "details": { } } }
```

## Publik (tanpa login)

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/health` | Cek server & database (`200` ok / `503` database bermasalah) |
| GET | `/api/config` | Info bisnis, metode bayar/ambil aktif, kategori. `payment_methods` memuat `qris` (dengan `mode`: `live`/`sandbox`/`mock` dan `expiry_minutes`) **hanya** jika gateway terkonfigurasi dan "Terima QRIS" menyala. Tidak ada kunci rahasia di sini |
| GET | `/api/products` | Menu. Setiap produk punya `availability`: `available` / `sold_out` / `unavailable`. `stock` hanya berisi angka jika stok dihitung, selain itu `null` |
| POST | `/api/orders` | Membuat pesanan (lihat di bawah) |
| POST | `/api/orders/track` | Melihat pesanan + status pembayaran (lihat "Lacak pesanan") |
| POST | `/api/orders/track/qr` | Gambar QRIS asli dari gateway untuk pembayaran yang menunggu |
| POST | `/api/orders/track/retry-payment` | Membuat kode QRIS baru setelah percobaan gagal (idempotent) |
| POST | `/api/orders/track/check-payment` | Menanyakan status pembayaran langsung ke gateway |
| POST | `/api/payments/midtrans/notification` | **Webhook** Midtrans (dipanggil gateway, bukan browser) |
| POST | `/api/contact` | Mengirim pesan kontak (`name`, `message`, opsional `email`, `phone`; kolom `website` harus kosong) |

### `POST /api/orders`

```json
{
  "items": [{ "product_id": 1, "quantity": 2 }],
  "customer_name": "Budi",
  "customer_phone": "081234567890",
  "fulfillment_method": "pickup | delivery",
  "delivery_address": "wajib (min. 10 karakter) jika delivery",
  "customer_notes": "opsional",
  "payment_method": "cod | bank_transfer | qris",
  "expected_total": 40000,
  "idempotency_key": "UUID baru untuk setiap pesanan"
}
```

Harga **tidak** dikirim klien; server membaca harga dari database. `expected_total` hanya dipakai untuk mendeteksi
harga yang berubah. Respons: `201 { order, replayed:false }`; permintaan ulang dengan `idempotency_key` dan isi
yang sama → `200 { order, replayed:true }` (tidak membuat pesanan ganda).

Respons juga memuat `tracking_token` (token acak 43 karakter untuk membuka halaman lacak), serta — untuk `qris` —
`payment` (`{status, amount, expires_at, qr_ready, can_retry, mode}`) dan `payment_error` (`null`, atau
`{code, message}` bila gateway gagal membuat kode; **pesanan tetap tersimpan** dan pelanggan bisa memakai
`/api/orders/track/retry-payment`). `payment_method: "qris"` hanya diterima bila QRIS aktif (provider terkonfigurasi
di server **dan** "Terima QRIS" menyala di Pengaturan); selain itu → `400 VALIDATION_ERROR` (pesan: "Pembayaran QRIS sedang tidak tersedia").
Pesanan QRIS **tidak dianggap lunas** oleh respons ini: status pembayarannya `pending`.

| Status | `error.code` | Arti |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Isian salah; `details.fields` berisi pesan per field |
| 409 | `CART_INVALID` | Menu tidak ada/habis/stok kurang; `details.problems[]` (`NOT_FOUND`, `UNAVAILABLE`, `OUT_OF_STOCK`, `INSUFFICIENT_STOCK`) |
| 409 | `PRICE_CHANGED` | Total berubah; `details` berisi total terbaru |
| 409 | `MIN_ORDER_NOT_MET` | Di bawah minimum pemesanan |
| 409 | `ORDERS_CLOSED` | Pemesanan online ditutup pemilik |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Kunci sama dipakai untuk isi pesanan berbeda |
| 429 | `RATE_LIMITED` | Terlalu banyak permintaan |

### Lacak pesanan (`POST /api/orders/track*`)

Semua memakai **POST + body JSON** (token tidak masuk URL/log). Akses dengan salah satu:

```json
{ "token": "43 karakter dari tautan lacak" }
```
```json
{ "order_number": "RB-261021-K7P2M", "phone": "081234567890" }
```

Kegagalan selalu `404 NOT_FOUND` dengan pesan yang sama (tidak membocorkan apakah nomor pesanan ada).
Percobaan gagal pada pencarian nomor+telepon dibatasi (`429 RATE_LIMITED`).

| Path | Fungsi | Respons / kesalahan khas |
|---|---|---|
| `/orders/track` | Ringkasan pesanan | `{ order, payment, labels, timeline }` — `order.order_status` dan `order.payment_status` **terpisah**; `payment` hanya untuk QRIS |
| `/orders/track/qr` | QR asli dari gateway | `{ content_type, data_uri }`; `409 QR_NOT_ACTIVE` (sudah tidak aktif/kedaluwarsa), `409 QR_NOT_READY`, `502 PAYMENT_PROVIDER_ERROR` |
| `/orders/track/retry-payment` | Kode QRIS baru | `201` bila dibuat, `200` bila sudah ada yang menunggu (tidak menggandakan transaksi); `409 NOT_QRIS` |
| `/orders/track/check-payment` | Tanya status ke gateway | `{ check, order, payment, … }`; dibatasi (jeda minimum antar pengecekan); `409 NOT_QRIS` |

Status pembayaran: `unpaid`, `pending`, `paid`, `failed`, `expired`, `cancelled`, `refunded`. Frontend **tidak pernah**
menentukan `paid`: nilai itu hanya berasal dari backend setelah konfirmasi gateway.

### Webhook gateway (`POST /api/payments/midtrans/notification`)

Didaftarkan di dashboard Midtrans (Payment Notification URL). Memproses notifikasi **tanpa sesi/CSRF** — keamanannya:

1. `signature_key` = SHA-512(`order_id` + `status_code` + `gross_amount` + Server Key) harus cocok → jika tidak `403`, tidak ada perubahan.
2. `order_id` harus dikenal; **nominal** (`gross_amount`) dan `transaction_id` harus cocok dengan data pembayaran → jika tidak,
   status tidak berubah dan pembayaran ditandai "perlu ditinjau" (`review_note`).
3. Untuk status "lunas", server menanyakan ulang ke API status Midtrans (kecuali dimatikan lewat `PAYMENT_VERIFY_STATUS_API=false`).
4. **Idempoten**: notifikasi sama berulang → `200` dengan `outcome` seperti `duplicate_status`/`duplicate`; tidak ada stok yang
   dikembalikan dua kali. Notifikasi terlambat/tidak berurutan tidak membuat status mundur (mis. "lunas" setelah "kedaluwarsa" dicatat dan ditandai untuk ditinjau).

Respons sukses: `200 { "ok": true, "outcome": "<hasil>" }`; balasan 2xx menghentikan percobaan ulang gateway. Nilai `outcome`:
`applied` (status diterapkan), `duplicate_status` / `duplicate_notification` (sudah pernah diproses; tidak ada perubahan),
`out_of_order` (status lebih lama dari yang tercatat; tidak ada kemunduran), `amount_mismatch` / `transaction_mismatch`
(tidak cocok; tidak ada perubahan + ditandai ditinjau), `unsupported_status`, `unknown_payment` (order_id tidak dikenal).

Kesalahan: `403 INVALID_SIGNATURE` (tanda tangan salah), `400 INVALID_NOTIFICATION` (isi tidak lengkap), `404 NOT_FOUND`
(QRIS tidak aktif di server), dan `503 PAYMENT_STATUS_UNAVAILABLE` / `PAYMENT_NOT_CONFIRMED` (status "lunas" belum bisa dikonfirmasi
ke API gateway — **sengaja bukan 2xx** agar gateway mengirim ulang nanti).

## Admin (`/api/admin/...`)

Semua endpoint admin (kecuali `login`) membutuhkan cookie sesi `HttpOnly`. Request yang mengubah data
(POST/PATCH/PUT/DELETE) juga wajib mengirim header `X-CSRF-Token` (nilainya dari respons `login` / `session`).
Tanpa sesi → `401 UNAUTHORIZED`; peran tidak cukup → `403 FORBIDDEN`.

| Method | Path | Peran | Fungsi |
|---|---|---|---|
| POST | `/login` | — | `{username, password}` → cookie sesi + `csrf_token` (gagal: `401 INVALID_CREDENTIALS`, `429`) |
| GET | `/session` | admin | Pengguna & token CSRF saat ini |
| POST | `/logout` | admin | Menghapus sesi |
| POST | `/password` | admin | `{current_password, new_password}` (min. 12 karakter) |
| GET | `/summary?from=&to=` | admin | Ringkasan (tanggal `YYYY-MM-DD`; keduanya atau tidak sama sekali): `totals` (nilai pesanan vs **pendapatan terverifikasi**), `top_products` (QRIS belum lunas tidak dihitung), `daily`, `payment_breakdown`, `attention` (perlu ditinjau, dibayar tetapi dibatalkan, `low_stock[]`, `low_stock_threshold`), `notes` |
| GET | `/orders` | admin | Daftar pesanan: `status`, `payment_status`, `q`, `from`, `to`, `page`, `page_size`. Tiap baris memuat `payment_status`, `payment_expires_at`, `gateway_reference` (id transaksi gateway terbaru), `needs_review` |
| GET | `/orders/:id` | admin | Detail + riwayat |
| PATCH | `/orders/:id/status` | admin | `{status, note?}` — hanya maju atau `cancelled`; batal mengembalikan stok sekali |
| PATCH | `/orders/:id/payment` | admin | `{payment_status, note?}` — tunai/transfer: `unpaid→paid`, `paid→refunded/unpaid`. **QRIS: hanya `paid→refunded`** (lunas hanya dari gateway) |
| POST | `/orders/:id/payment/refresh` | admin | Menanyakan status pembayaran QRIS ke gateway → `{ check, order }` |
| GET | `/products` | admin | Daftar (opsi `q`, `category`, `include_deleted=1`) |
| POST | `/products` | admin | Tambah produk |
| GET/PATCH | `/products/:id` | admin | Lihat / ubah sebagian |
| DELETE | `/products/:id` | **owner** | Hapus lunak (riwayat pesanan tetap utuh) |
| POST | `/uploads` | admin | `multipart/form-data` field `image` (JPG/PNG/WebP) → `{path}` |
| GET | `/settings` | admin | Pengaturan bisnis + metadata field + `payment` (konfigurasi QRIS **tanpa kunci rahasia**: `configured`, `provider`, `mode`, `webhook_url`, `expiry_minutes`, `warnings[]`) |
| PUT | `/settings` | **owner** | Simpan pengaturan (hanya key yang dikenal) |
| GET | `/messages` | admin | Pesan kontak (`unread=1`, `page`) |
| PATCH | `/messages/:id` | admin | `{is_read: true|false}` |

Status pesanan: `pending → confirmed → preparing → ready → completed`, atau `cancelled` dari status non-final.
Status pembayaran: `unpaid` (tunai/transfer belum diterima), `pending` (QRIS menunggu), `paid` (tunai/transfer: ditandai admin;
**QRIS: hanya dikonfirmasi gateway**), `failed` / `expired` / `cancelled` (percobaan QRIS tidak berhasil), `refunded`.
Pesanan QRIS tidak bisa diproses sebelum `paid` (`409 PAYMENT_REQUIRED`; pembatalan tetap boleh). Pendapatan di ringkasan hanya menghitung `paid`.
