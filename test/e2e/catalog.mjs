// Skenario browser untuk katalog 30 menu: jumlah tepat 30, tanpa duplikat (juga setelah seed diulang), urut harga,
// filter kategori, pencarian, gambar pengganti, indikator habis, serta keadaan memuat/kosong/gagal.
//
// Dijalankan PALING AKHIR: skenario ini menyembunyikan (soft delete) menu uji milik skenario lain agar yang tampil
// hanya 30 menu seed. Hanya menyentuh database *_test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from '../../src/config/env.js';
import { inspectCatalog, seedProducts } from '../../src/services/seedService.js';

const priceOf = (text) => Number(String(text).replace(/\D/g, ''));

export async function runCatalogScenarios({ browser, server, runner }) {
  const { baseUrl, pool } = server;
  const { scenario } = runner;
  const seed = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'db', 'seeds', 'products.json'), 'utf8'));
  assert.equal(seed.length, 30, 'file seed harus berisi tepat 30 menu');

  async function newPage(viewport = { width: 1280, height: 900 }, { wait = true } = {}) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.problems = [];
    page.on('pageerror', (error) => page.problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      const text = message.text();
      // 500 pada skenario "gagal memuat" disengaja; sumber luar (font) tidak terjangkau di lingkungan uji.
      if (message.type() === 'error' && !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|status of 500/.test(text)) {
        page.problems.push(`console.error: ${text}`);
      }
      if (/Content Security Policy/i.test(text)) page.problems.push(`CSP: ${text}`);
    });
    if (wait) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.menu-card:not(.skeleton)');
    }
    return page;
  }

  const titles = (page) => page.locator('#menu-grid .menu-card-title').allTextContents();
  const prices = async (page) => (await page.locator('#menu-grid .menu-card-price').allTextContents()).map(priceOf);
  const cardCount = (page) => page.locator('.menu-card:not(.skeleton)').count();
  const waitForSortedGrid = (page, expectedCount) =>
    page.waitForFunction((n) => document.querySelectorAll('.menu-card:not(.skeleton)').length === n, expectedCount);

  // Menyiapkan: sembunyikan menu uji lama lalu seed 30 menu lewat kode seed yang SAMA dengan `npm run seed:products`.
  await pool.execute("UPDATE products SET deleted_at = NOW() WHERE deleted_at IS NULL");
  const firstSeed = await seedProducts(pool, seed);

  // ------------------------------------------------------------------
  await scenario('Katalog: tepat 30 menu aktif, tanpa nama ganda, kartu lengkap — dan tetap 30 setelah seed diulang', async () => {
    assert.equal(firstSeed.inserted.length, 30);
    const page = await newPage();
    assert.equal(await cardCount(page), 30);
    assert.match(await page.locator('#menu-count').innerText(), /Menampilkan 30 menu/);
    const names = await titles(page);
    assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 30, 'tidak boleh ada nama menu ganda di tampilan');

    // Setiap kartu: foto, nama, deskripsi, harga, kategori, status, tombol tambah.
    const incomplete = await page.locator('.menu-card:not(.skeleton)').evaluateAll((cards) =>
      cards
        .filter(
          (card) =>
            !card.querySelector('img.menu-card-img') ||
            !card.querySelector('.menu-card-title')?.textContent.trim() ||
            !card.querySelector('.menu-card-description')?.textContent.trim() ||
            !/^Rp[\d.]+$/.test(card.querySelector('.menu-card-price')?.textContent.trim() ?? '') ||
            !card.querySelector('.menu-card-category')?.textContent.trim() ||
            !card.querySelector('.menu-card-status')?.textContent.trim() ||
            !card.querySelector('[data-add]'),
        )
        .map((card) => card.querySelector('.menu-card-title')?.textContent),
    );
    assert.deepEqual(incomplete, [], 'kartu tidak lengkap');

    // Tombol kategori: Semua + 4 kategori yang punya menu (kategori kosong tidak ditampilkan)
    const categories = await page.locator('[data-category]').evaluateAll((buttons) => buttons.map((button) => button.dataset.category));
    assert.deepEqual(categories, ['all', 'makanan', 'minuman', 'jajanan', 'paket']);

    // Seed diulang (juga setelah pemilik mengubah harga): tidak ada penambahan, tidak ada duplikat, edit pemilik tidak tertimpa.
    await pool.execute("UPDATE products SET price = 99000 WHERE name = 'Nasi Kentut'");
    const again = await seedProducts(pool, seed);
    assert.equal(again.inserted.length, 0);
    assert.equal(again.existing.length, 30);
    const catalog = await inspectCatalog(pool);
    assert.equal(catalog.active, 30);
    assert.deepEqual(catalog.duplicates, []);
    assert.equal((await pool.query("SELECT price FROM products WHERE name = 'Nasi Kentut'"))[0][0].price, 99000, 'edit pemilik tidak boleh ditimpa seed');
    await pool.execute("UPDATE products SET price = 20000 WHERE name = 'Nasi Kentut'");
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu-card:not(.skeleton)');
    assert.equal(await cardCount(page), 30);
    assert.deepEqual(page.problems, []);
    await page.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Urut harga: termurah / termahal / nama A–Z bekerja, jumlah tetap 30, "Rekomendasi" memulihkan urutan awal', async () => {
    const page = await newPage();
    const original = await titles(page);

    await page.selectOption('#sort-select', 'price-asc');
    const asc = await prices(page);
    assert.equal(asc.length, 30);
    assert.deepEqual(asc, [...asc].sort((a, b) => a - b), 'harga harus naik');
    assert.ok(asc[0] < asc[asc.length - 1]);

    await page.selectOption('#sort-select', 'price-desc');
    const desc = await prices(page);
    assert.deepEqual(desc, [...desc].sort((a, b) => b - a), 'harga harus turun');
    assert.equal(desc[0], asc[asc.length - 1]);

    await page.selectOption('#sort-select', 'name-asc');
    const byName = await titles(page);
    assert.deepEqual(byName, [...byName].sort((a, b) => a.localeCompare(b, 'id')));

    await page.selectOption('#sort-select', 'default');
    assert.deepEqual(await titles(page), original);

    // Urut harga + filter kategori + pencarian bekerja bersama
    await page.selectOption('#sort-select', 'price-desc');
    await page.click('[data-category="minuman"]');
    const drinks = await prices(page);
    assert.equal(drinks.length, 9);
    assert.deepEqual(drinks, [...drinks].sort((a, b) => b - a));
    await page.click('#search-btn');
    await page.fill('#search-input', 'dawet');
    const filtered = await titles(page);
    assert.ok(filtered.length > 0 && filtered.length < 9);
    const filteredPrices = await prices(page);
    assert.deepEqual(filteredPrices, [...filteredPrices].sort((a, b) => b - a), 'urutan dipertahankan saat mencari');
    assert.deepEqual(page.problems, []);
    await page.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Filter kategori & pencarian sesuai isi database (jumlah per kategori, kata kunci, tidak ditemukan)', async () => {
    const page = await newPage();
    const [rows] = await pool.query('SELECT category, COUNT(*) AS n FROM products WHERE deleted_at IS NULL GROUP BY category');
    for (const { category, n } of rows) {
      await page.click(`[data-category="${category}"]`);
      assert.equal(await cardCount(page), Number(n), `kategori ${category}`);
      assert.equal(await page.locator(`[data-category="${category}"]`).getAttribute('aria-pressed'), 'true');
    }
    await page.click('[data-category="all"]');
    assert.equal(await cardCount(page), 30);

    // kata kunci dari nama menu tertentu (tidak peka huruf besar/kecil) -> menu itu ada, semua hasil memuat kata itu
    await page.click('#search-btn');
    await page.fill('#search-input', 'DAWET');
    const hits = await page.locator('.menu-card:not(.skeleton)').allInnerTexts();
    assert.ok(hits.length >= 1 && hits.some((text) => /Es Dawet Jembut Kecabut/.test(text)));
    assert.ok(hits.every((text) => /dawet/i.test(text)));

    await page.fill('#search-input', 'xyz-tidak-ada');
    assert.equal(await cardCount(page), 0);
    assert.match(await page.locator('#menu-status').innerText(), /Menu tidak ditemukan/);
    await page.click('#menu-status button');
    await waitForSortedGrid(page, 30);
    await page.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Gambar: foto asli untuk menu berfoto, ilustrasi per kategori untuk yang belum (semua gambar benar-benar termuat)', async () => {
    const page = await newPage();
    // Gambar kartu memakai loading="lazy"; paksa semuanya dimuat agar seluruh 30 gambar bisa diperiksa tanpa menggulir.
    await page.evaluate(() => document.querySelectorAll('#menu-grid .menu-card-img').forEach((img) => (img.loading = 'eager')));
    await page.waitForFunction(() => [...document.querySelectorAll('#menu-grid .menu-card-img')].every((img) => img.complete));
    const images = await page.locator('#menu-grid .menu-card-img').evaluateAll((imgs) =>
      imgs.map((img) => ({ src: new URL(img.src).pathname, loaded: img.naturalWidth > 0, alt: img.alt })),
    );
    assert.equal(images.length, 30);
    assert.ok(images.every((image) => image.loaded), `gambar gagal termuat: ${images.filter((i) => !i.loaded).map((i) => i.src)}`);
    const withPhoto = seed.filter((product) => product.image).length;
    assert.equal(images.filter((image) => image.src.startsWith('/images/products/')).length, withPhoto);
    const placeholders = images.filter((image) => image.src.startsWith('/images/placeholders/'));
    assert.equal(placeholders.length, 30 - withPhoto);
    assert.ok(placeholders.every((image) => /foto belum tersedia/.test(image.alt)), 'ilustrasi pengganti harus jujur lewat teks alternatif');
    // setiap kategori memakai ilustrasinya sendiri
    for (const category of ['makanan', 'minuman', 'jajanan', 'paket']) {
      assert.ok(placeholders.some((image) => image.src === `/images/placeholders/${category}.svg`), `ilustrasi ${category}`);
    }

    // Foto yang rusak/hilang jatuh ke ilustrasi kategori (bukan ikon gambar pecah)
    await pool.execute("UPDATE products SET image = '/images/products/tidak-ada.jpeg' WHERE name = 'Mie Lendir'");
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu-card:not(.skeleton)');
    const broken = page.locator('#menu-grid .menu-card', { hasText: 'Mie Lendir' }).locator('img.menu-card-img');
    await page.waitForFunction(() => {
      const card = [...document.querySelectorAll('.menu-card')].find((c) => c.textContent.includes('Mie Lendir'));
      const img = card?.querySelector('img');
      return img && img.complete && img.naturalWidth > 0 && img.src.includes('/images/placeholders/makanan.svg');
    });
    assert.match(await broken.getAttribute('src'), /placeholders\/makanan\.svg$/);
    await pool.execute("UPDATE products SET image = '/images/products/mie-lendir.jpeg' WHERE name = 'Mie Lendir'");
    await page.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Indikator stok: "Habis" menonaktifkan tombol, "Sisa N" untuk stok menipis, "Tidak tersedia" untuk yang disembunyikan', async () => {
    await pool.execute("UPDATE products SET track_stock = 1, stock = 0 WHERE name = 'Mie Lendir'");
    await pool.execute("UPDATE products SET track_stock = 1, stock = 3 WHERE name = 'Es Dawet Jembut Kecabut'");
    await pool.execute("UPDATE products SET is_available = 0 WHERE name = 'Ketela Bajingan'");
    try {
      const page = await newPage();
      const card = (name) => page.locator('.menu-card', { hasText: name });
      assert.match(await card('Mie Lendir').locator('.menu-card-status').innerText(), /Habis/);
      assert.equal(await card('Mie Lendir').locator('[data-add]').isDisabled(), true);
      assert.match(await card('Mie Lendir').innerText(), /Stok Habis/);
      assert.match(await card('Es Dawet Jembut Kecabut').locator('.menu-card-status').innerText(), /Sisa 3/);
      assert.equal(await card('Es Dawet Jembut Kecabut').locator('[data-add]').isDisabled(), false);
      assert.match(await card('Ketela Bajingan').locator('.menu-card-status').innerText(), /Tidak tersedia/);
      assert.equal(await card('Ketela Bajingan').locator('[data-add]').isDisabled(), true);
      assert.equal(await card('Nasi Kentut').locator('.menu-card-status').innerText(), 'Tersedia');
      await page.context().close();
    } finally {
      await pool.execute("UPDATE products SET track_stock = 0, stock = 0 WHERE name IN ('Mie Lendir', 'Es Dawet Jembut Kecabut')");
      await pool.execute("UPDATE products SET is_available = 1 WHERE name = 'Ketela Bajingan'");
    }
  });

  // ------------------------------------------------------------------
  await scenario('Keadaan memuat / gagal / kosong: pesan jelas dan tombol "Coba lagi" benar-benar memuat ulang', async () => {
    // gagal (server 500) lalu pulih
    const failing = await newPage(undefined, { wait: false });
    let fail = true;
    await failing.route('**/api/products', (route) =>
      fail ? route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan pada server. Silakan coba lagi.' } } }) : route.continue(),
    );
    await failing.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await failing.waitForSelector('#menu-status h3');
    assert.match(await failing.locator('#menu-status').innerText(), /Menu belum bisa dimuat/);
    assert.equal(await cardCount(failing), 0);
    fail = false;
    await failing.click('#menu-status button'); // "Coba lagi"
    await waitForSortedGrid(failing, 30);
    await failing.context().close();

    // kosong
    const empty = await newPage(undefined, { wait: false });
    await empty.route('**/api/products', (route) => route.fulfill({ json: { products: [] } }));
    await empty.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await empty.waitForSelector('#menu-status h3');
    assert.match(await empty.locator('#menu-status').innerText(), /Menu belum tersedia/);
    await empty.context().close();

    // memuat: kerangka kartu tampil selagi data ditunggu
    const slow = await newPage(undefined, { wait: false });
    await slow.route('**/api/products', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });
    await slow.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await slow.waitForSelector('.menu-card.skeleton');
    assert.match(await slow.locator('#menu-status').innerText(), /Memuat menu/);
    await waitForSortedGrid(slow, 30);
    assert.equal(await slow.locator('.menu-card.skeleton').count(), 0);
    await slow.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Responsif: 30 menu + urutan di 320 / 390 / 768 / 1440 px tanpa geser horizontal', async () => {
    for (const width of [320, 390, 768, 1440]) {
      const page = await newPage({ width, height: 800 });
      assert.equal(await cardCount(page), 30);
      await page.selectOption('#sort-select', 'price-asc');
      assert.equal(await page.locator('#sort-select').isVisible(), true);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      // Jika meluber, sebutkan elemen penyebabnya agar mudah diperbaiki.
      const culprits =
        overflow > 0
          ? await page.evaluate(() =>
              [...document.querySelectorAll('body *')]
                .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
                .slice(0, 6)
                .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`),
            )
          : [];
      assert.ok(overflow <= 0, `lebar ${width}px: geser horizontal ${overflow}px, penyebab: ${culprits.join(' | ')}`);
      await page.context().close();
    }
  });
}
