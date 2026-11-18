// Helper tanggal. Database menyimpan waktu dalam UTC;
// laporan dan nomor pesanan memakai zona waktu bisnis (default WIB = UTC+7).
import { badRequest } from './errors.js';

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** Mengubah "YYYY-MM-DD" menjadi komponen angka, atau melempar error jika tanggal tidak nyata. */
function parseDateOnly(value, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) throw badRequest(`Format ${label} harus YYYY-MM-DD.`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw badRequest(`${label} bukan tanggal yang valid.`);
  }
  return { year, month, day };
}

/** Tanggal bisnis (YYYY-MM-DD) untuk sebuah momen UTC. */
export function businessDateString(date, offsetMinutes) {
  return new Date(date.getTime() + offsetMinutes * MS_PER_MINUTE).toISOString().slice(0, 10);
}

/** Awal hari bisnis (00:00 waktu bisnis) sebagai momen UTC. */
export function businessDayStartUtc(dateString, offsetMinutes, label = 'Tanggal') {
  const { year, month, day } = parseDateOnly(dateString, label);
  return new Date(Date.UTC(year, month - 1, day) - offsetMinutes * MS_PER_MINUTE);
}

/** Awal hari BERIKUTNYA (batas atas eksklusif) untuk sebuah tanggal bisnis. */
export function businessDayEndExclusiveUtc(dateString, offsetMinutes, label = 'Tanggal') {
  return new Date(businessDayStartUtc(dateString, offsetMinutes, label).getTime() + MS_PER_DAY);
}

/**
 * Mengubah rentang tanggal bisnis [from, to] (inklusif) menjadi rentang UTC [start, endExclusive).
 * Contoh WIB: 2026-10-09 s/d 2026-10-09  =>  2026-10-08T17:00Z s/d 2026-10-09T17:00Z
 */
export function businessRangeToUtc(from, to, offsetMinutes, { maxDays = 366 } = {}) {
  const startUtc = businessDayStartUtc(from, offsetMinutes, 'Tanggal awal');
  const endExclusive = businessDayEndExclusiveUtc(to, offsetMinutes, 'Tanggal akhir');
  if (endExclusive <= startUtc) throw badRequest('Tanggal akhir tidak boleh sebelum tanggal awal.');
  if ((endExclusive - startUtc) / MS_PER_DAY > maxDays) {
    throw badRequest(`Rentang tanggal maksimal ${maxDays} hari.`);
  }
  return { start: startUtc, endExclusive };
}

/** Rentang default laporan: 30 hari terakhir (termasuk hari ini) menurut zona waktu bisnis. */
export function defaultReportRange(now, offsetMinutes) {
  const today = businessDateString(now, offsetMinutes);
  const fromDate = new Date(new Date(`${today}T00:00:00Z`).getTime() - 29 * MS_PER_DAY);
  return { from: fromDate.toISOString().slice(0, 10), to: today };
}
