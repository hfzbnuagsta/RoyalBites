// Validasi input di SERVER dengan library zod. Frontend juga memvalidasi demi kenyamanan pengguna,
// tetapi yang menjadi penjaga sebenarnya adalah file ini.
import { z } from 'zod';
import { AppError, badRequest } from './errors.js';
import { normalizeIndonesianMobile } from './phone.js';

// Menghapus karakter kontrol tak terlihat (kecuali baris baru & tab) dari input teks.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** String yang di-trim dan dibersihkan dari karakter kontrol, dengan batas panjang. */
export function text({ min = 0, max, label = 'Isian' }) {
  return z
    .string({
      required_error: `${label} wajib diisi.`,
      invalid_type_error: `${label} harus berupa teks.`,
    })
    .transform((value) => value.replace(CONTROL_CHARS, '').trim())
    .pipe(
      z
        .string()
        .min(min, min === 1 ? `${label} wajib diisi.` : `${label} minimal ${min} karakter.`)
        .max(max, `${label} maksimal ${max} karakter.`),
    );
}

/** Nomor HP/WhatsApp Indonesia; hasilnya sudah dinormalisasi ke format 62xxxxxxxxxx. */
export function indonesianMobile(label = 'Nomor WhatsApp') {
  return z
    .string({ required_error: `${label} wajib diisi.`, invalid_type_error: `${label} tidak valid.` })
    .transform((value, ctx) => {
      const normalized = normalizeIndonesianMobile(value);
      if (!normalized) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} tidak valid. Contoh: 081234567890`,
        });
        return z.NEVER;
      }
      return normalized;
    });
}

/** Bilangan bulat (bukan string, bukan pecahan) dengan batas. */
export function integer({ min, max, label = 'Angka' }) {
  return z
    .number({ required_error: `${label} wajib diisi.`, invalid_type_error: `${label} harus berupa angka.` })
    .int(`${label} harus bilangan bulat.`)
    .min(min, `${label} minimal ${min}.`)
    .max(max, `${label} maksimal ${max}.`);
}

/** Mengubah hasil gagal zod menjadi AppError 400 dengan daftar field yang salah. */
export function parseOrThrow(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;

  const fields = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  const first = Object.values(fields)[0];
  throw new AppError(400, 'VALIDATION_ERROR', first || 'Data yang dikirim tidak valid.', { fields });
}

/** Parameter ID di URL (mis. /products/12) harus berupa bilangan bulat positif. */
export function parseIdParam(value) {
  if (!/^\d{1,10}$/.test(String(value ?? ''))) throw badRequest('ID tidak valid.');
  const id = Number(value);
  if (id < 1 || id > 4_294_967_295) throw badRequest('ID tidak valid.');
  return id;
}

/** Meloloskan karakter khusus LIKE (% dan _) agar pencarian pengguna tidak jadi wildcard. */
export function escapeLike(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
