// Tanda tangan notifikasi (webhook) Midtrans.
//   signature_key = SHA512(order_id + status_code + gross_amount + ServerKey)
// Sumber: dokumentasi resmi Midtrans, "Handling HTTP Notification".
// Nilai order_id, status_code, gross_amount dipakai PERSIS seperti teks yang dikirim Midtrans
// (mis. gross_amount "20000.00"), bukan angka hasil konversi.
import crypto from 'node:crypto';

export function midtransSignature({ orderId, statusCode, grossAmount, serverKey }) {
  return crypto
    .createHash('sha512')
    .update(`${orderId}${statusCode}${grossAmount}${serverKey}`, 'utf8')
    .digest('hex');
}

/** true hanya jika semua field ada bertipe string/angka dan tanda tangannya cocok. */
export function verifyMidtransSignature(body, serverKey) {
  if (!body || typeof body !== 'object' || !serverKey) return false;
  const { order_id: orderId, status_code: statusCode, gross_amount: grossAmount, signature_key: given } = body;
  const isText = (value) => typeof value === 'string' || typeof value === 'number';
  if (!isText(orderId) || !isText(statusCode) || !isText(grossAmount) || typeof given !== 'string') return false;

  const expected = midtransSignature({
    orderId: String(orderId),
    statusCode: String(statusCode),
    grossAmount: String(grossAmount),
    serverKey,
  });
  const providedBuffer = Buffer.from(given.trim().toLowerCase(), 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  // Perbandingan waktu-konstan; panjang berbeda langsung ditolak.
  return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}
