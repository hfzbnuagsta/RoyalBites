// Normalisasi nomor telepon/WhatsApp Indonesia ke format internasional tanpa tanda "+" (62...).
// Contoh: "0812-3456-7890" -> "6281234567890", "+62 812 3456 7890" -> "6281234567890"

/**
 * @returns {string|null} nomor ternormalisasi, atau null jika bukan nomor seluler Indonesia yang masuk akal.
 */
export function normalizeIndonesianMobile(input) {
  if (typeof input !== 'string') return null;
  // Hapus spasi, tanda hubung, titik, dan kurung. Karakter lain berarti input tidak valid.
  const cleaned = input.trim().replace(/[\s\-.()]/g, '');
  if (!/^\+?\d+$/.test(cleaned)) return null;

  let digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  else if (digits.startsWith('8')) digits = `62${digits}`; // pengguna lupa mengetik 0

  // Nomor seluler Indonesia: 62 8xx + 8 sampai 11 digit lagi (total 10-13 digit setelah 62).
  if (!/^628\d{8,11}$/.test(digits)) return null;
  return digits;
}
