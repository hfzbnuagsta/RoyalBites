// Test unit: fungsi murni (tanpa database/server).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectImageType } from '../../src/middleware/upload.js';
import { assertPasswordPolicy } from '../../src/services/authService.js';
import { generateOrderNumber, isValidStatusTransition } from '../../src/services/orderService.js';
import { businessDateString, businessDayEndExclusiveUtc, businessDayStartUtc, businessRangeToUtc } from '../../src/utils/dates.js';
import { normalizeIndonesianMobile } from '../../src/utils/phone.js';
import { escapeLike, parseIdParam } from '../../src/utils/validation.js';

describe('normalizeIndonesianMobile', () => {
  const valid = [
    ['081234567890', '6281234567890'],
    ['0812-3456-7890', '6281234567890'],
    ['+62 812 3456 7890', '6281234567890'],
    ['6281234567890', '6281234567890'],
    ['81234567890', '6281234567890'],
    ['(0812) 3456.7890', '6281234567890'],
  ];
  for (const [input, expected] of valid) {
    test(`menerima "${input}"`, () => assert.equal(normalizeIndonesianMobile(input), expected));
  }
  const invalid = ['', 'abc', '12345', '0212345678', '08123', '+1 202 555 0100', '0812345678901234567', '0812-abc-7890', null, undefined, 62812];
  for (const input of invalid) {
    test(`menolak ${JSON.stringify(input)}`, () => assert.equal(normalizeIndonesianMobile(input), null));
  }
});

describe('tanggal zona waktu bisnis (WIB = UTC+7)', () => {
  test('awal hari WIB adalah 17:00 UTC hari sebelumnya', () => {
    assert.equal(businessDayStartUtc('2026-10-09', 420).toISOString(), '2026-10-08T17:00:00.000Z');
  });
  test('batas akhir eksklusif adalah awal hari berikutnya', () => {
    assert.equal(businessDayEndExclusiveUtc('2026-10-09', 420).toISOString(), '2026-10-09T17:00:00.000Z');
  });
  test('pesanan jam 23:30 WIB masih tanggal yang sama', () => {
    assert.equal(businessDateString(new Date('2026-10-09T16:30:00Z'), 420), '2026-10-09');
    assert.equal(businessDateString(new Date('2026-10-09T17:00:00Z'), 420), '2026-10-10');
  });
  test('menolak tanggal yang tidak nyata', () => {
    assert.throws(() => businessDayStartUtc('2026-02-30', 420), /bukan tanggal yang valid/);
    assert.throws(() => businessDayStartUtc('09-10-2026', 420), /YYYY-MM-DD/);
  });
  test('rentang terbalik dan terlalu panjang ditolak', () => {
    assert.throws(() => businessRangeToUtc('2026-10-10', '2026-10-01', 420), /tidak boleh sebelum/);
    assert.throws(() => businessRangeToUtc('2020-01-01', '2026-10-01', 420), /maksimal/);
  });
});

describe('transisi status pesanan', () => {
  const allowed = [
    ['pending', 'confirmed'],
    ['pending', 'preparing'],
    ['confirmed', 'ready'],
    ['ready', 'completed'],
    ['pending', 'cancelled'],
    ['preparing', 'cancelled'],
    ['ready', 'cancelled'],
  ];
  const denied = [
    ['completed', 'cancelled'],
    ['cancelled', 'pending'],
    ['cancelled', 'completed'],
    ['completed', 'pending'],
    ['preparing', 'confirmed'],
    ['pending', 'pending'],
  ];
  for (const [from, to] of allowed) test(`${from} -> ${to} diizinkan`, () => assert.equal(isValidStatusTransition(from, to), true));
  for (const [from, to] of denied) test(`${from} -> ${to} ditolak`, () => assert.equal(isValidStatusTransition(from, to), false));
});

describe('nomor pesanan', () => {
  test('format RB-yymmdd-XXXXX tanpa huruf/angka yang mudah tertukar', () => {
    const number = generateOrderNumber(new Date('2026-10-09T10:00:00Z'), 420);
    assert.match(number, /^RB-261009-[A-HJ-NP-Z2-9]{5}$/);
  });
  test('hampir tidak pernah berulang pada 2000 percobaan', () => {
    // Ruang nomor = 32^5 (~33,5 juta), sehingga tabrakan acak di antara 2000 nomor ada peluangnya (~6% per
    // proses; paradoks ulang tahun). Itu BUKAN bug: tabrakan di database ditangani (INSERT diulang dengan
    // nomor baru; diuji di test/integration/orders.test.js, "nomor pesanan bentrok"). Maka yang diuji adalah "nyaris unik", bukan "pasti unik" —
    // versi lama (harus persis 2000) sesekali gagal tanpa ada yang salah di kode.
    const seen = new Set();
    for (let i = 0; i < 2000; i += 1) seen.add(generateOrderNumber(new Date(), 420));
    assert.ok(seen.size >= 1990, `terlalu banyak tabrakan: ${2000 - seen.size}`);
  });
});

describe('kebijakan password', () => {
  test('menerima password kuat', () => assert.doesNotThrow(() => assertPasswordPolicy('KataSandiKuat-2026', 'owner')));
  test('menolak < 12 karakter', () => assert.throws(() => assertPasswordPolicy('Pendek1!'), /minimal 12/));
  test('menolak satu karakter berulang', () => assert.throws(() => assertPasswordPolicy('aaaaaaaaaaaaaa'), /diulang/));
  test('menolak password umum', () => assert.throws(() => assertPasswordPolicy('PASSWORD1234'), /umum/));
  test('menolak yang memuat username', () => assert.throws(() => assertPasswordPolicy('xxowner-rahasia-xx', 'owner'), /username/));
  test('menolak > 72 byte (batas bcrypt)', () => assert.throws(() => assertPasswordPolicy('a1'.repeat(40)), /72/));
});

describe('deteksi tipe gambar dari isi file', () => {
  test('JPEG', () => assert.deepEqual(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), { ext: 'jpg' }));
  test('PNG', () => assert.deepEqual(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), { ext: 'png' }));
  test('WebP', () => assert.deepEqual(detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), { ext: 'webp' }));
  test('menolak SVG, HTML, GIF, dan teks', () => {
    for (const content of ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', '<html><script>alert(1)</script>', 'GIF89a....', 'bukan gambar']) {
      assert.equal(detectImageType(Buffer.from(content)), null);
    }
  });
  test('menolak buffer kosong/pendek', () => {
    assert.equal(detectImageType(Buffer.alloc(0)), null);
    assert.equal(detectImageType(Buffer.from([0xff, 0xd8])), null);
  });
});

describe('validasi parameter', () => {
  test('ID valid', () => assert.equal(parseIdParam('42'), 42));
  for (const bad of ['0', '-1', '1.5', 'abc', '1e3', '99999999999', '', undefined, '1; DROP TABLE orders']) {
    test(`ID ${JSON.stringify(bad)} ditolak`, () => assert.throws(() => parseIdParam(bad), /ID tidak valid/));
  }
  test('escapeLike meloloskan %, _, dan backslash', () => assert.equal(escapeLike('50%_a\\b'), '50\\%\\_a\\\\b'));
});
