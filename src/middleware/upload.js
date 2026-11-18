// Upload gambar produk dengan validasi ketat.
//  - Ukuran dibatasi (UPLOAD_MAX_MB).
//  - Tipe file ditentukan dari ISI file (magic bytes), bukan dari nama/ekstensi/Content-Type kiriman klien.
//  - Hanya JPEG, PNG, WebP. SVG sengaja DITOLAK karena bisa memuat JavaScript.
//  - Nama file dibuat acak oleh server; nama asli dari klien tidak pernah dipakai.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { AppError, badRequest } from '../utils/errors.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg' };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ext: 'png' };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { ext: 'webp' };
  }
  return null;
}

/** Middleware multer: membaca satu file di field "image" ke memori (maks. UPLOAD_MAX_MB). */
export function createImageParser(config) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.uploads.maxBytes, files: 1, fields: 0, parts: 2 },
  });
  return upload.single('image');
}

/** Memvalidasi file hasil multer lalu menyimpannya ke folder uploads. Mengembalikan path publiknya. */
export async function saveUploadedImage(config, file) {
  if (!file) throw badRequest('Pilih file gambar terlebih dahulu (field "image").');
  const type = detectImageType(file.buffer);
  if (!type) {
    throw new AppError(415, 'UNSUPPORTED_IMAGE', 'File harus berupa gambar JPEG, PNG, atau WebP yang valid.');
  }
  await fs.mkdir(config.uploads.dir, { recursive: true });
  const fileName = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
  // flag "wx": gagal jika file sudah ada (tidak pernah menimpa file lain).
  await fs.writeFile(path.join(config.uploads.dir, fileName), file.buffer, { flag: 'wx', mode: 0o644 });
  return `/uploads/${fileName}`;
}
