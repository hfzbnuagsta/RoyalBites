// Skenario pelanggan di browser: katalog dari DB, pencarian/filter, keranjang, checkout, stok, harga, klik ganda.
import assert from 'node:assert/strict';

const money = (n) => `Rp${n.toLocaleString('id-ID')}`;

export async function runCustomerScenarios({ browser, server, runner }) {
  const { baseUrl, pool } = server;
  const { scenario } = runner;

  async function newPage(viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.problems = [];
    page.on('pageerror', (error) => page.problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      // Sumber luar (Google Fonts/Maps, gambar kumparan) tidak bisa dijangkau di lingkungan uji; bukan bug aplikasi.
      const text = message.text();
      if (message.type() === 'error' && !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/.test(text)) {
        page.problems.push(`console.error: ${text}`);
      }
      if (/Content Security Policy/i.test(text)) page.problems.push(`CSP: ${text}`);
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu-card:not(.skeleton)');
    return page;
  }

  const productId = async (name) => (await pool.query('SELECT id FROM products WHERE name = ?', [name]))[0][0].id;
  const stockOf = async (name) => (await pool.query('SELECT stock FROM products WHERE name = ?', [name]))[0][0].stock;
  const orderCount = async () => (await pool.query('SELECT COUNT(*) AS n FROM orders'))[0][0].n;
  const addButton = (page, id) => page.locator(`[data-add="${id}"]`);

  async function fillCheckout(page, { name = 'Budi Uji', phone = '0812-3456-7890', delivery = false, payment = 'cod', address = '', notes = '' } = {}) {
    await page.fill('#co-name', name);
    await page.fill('#co-phone', phone);
    if (delivery) await page.check('input[name="fulfillment_method"][value="delivery"]');
    else await page.check('input[name="fulfillment_method"][value="pickup"]');
    if (delivery) await page.fill('#co-address', address || 'Jl. Uji Coba No. 12, Kota Uji');
    if (notes) await page.fill('#co-notes', notes);
    await page.check(`input[name="payment_method"][value="${payment}"]`);
  }

  // ------------------------------------------------------------------
  await scenario('Katalog dimuat dari database (bukan data statis) dan produk nonaktif tidak bisa dipesan', async () => {
    const page = await newPage();
    const names = await page.locator('.menu-card-title').allTextContents();
    assert.deepEqual([...names].sort(), ['Es Terbatas', 'Kue Nonaktif', 'Menu Habis', 'Nasi Uji']);
    await assert.doesNotReject(page.locator('.menu-card', { hasText: 'Nasi Uji' }).getByText('Rp20.000').waitFor({ timeout: 2000 }));
    assert.equal(await addButton(page, await productId('Menu Habis')).isDisabled(), true, 'produk habis harus nonaktif');
    assert.equal(await addButton(page, await productId('Kue Nonaktif')).isDisabled(), true, 'produk tidak tersedia harus nonaktif');
    assert.equal(await addButton(page, await productId('Nasi Uji')).isDisabled(), false);
    assert.deepEqual(page.problems, []);
    await page.context().close();
  });

  await scenario('Pencarian & filter kategori bekerja (digabung), dengan pesan saat kosong', async () => {
    const page = await newPage();
    const visible = async () => (await page.locator('.menu-card-title').allTextContents()).sort();

    await page.click('#search-btn');
    await page.fill('#search-input', 'es');
    assert.deepEqual(await visible(), ['Es Terbatas']);
    await page.fill('#search-input', 'NASI'); // tidak peka huruf besar/kecil
    assert.deepEqual(await visible(), ['Nasi Uji']);
    await page.fill('#search-input', 'tidak-ada-menu-ini');
    assert.equal(await page.locator('.menu-card').count(), 0);
    assert.match(await page.locator('#menu-status').innerText(), /Menu tidak ditemukan/);
    await page.click('#menu-status button'); // "Tampilkan semua menu"
    assert.equal((await visible()).length, 4);

    await page.click('[data-category="minuman"]');
    assert.deepEqual(await visible(), ['Es Terbatas']);
    assert.equal(await page.locator('[data-category="minuman"]').getAttribute('aria-pressed'), 'true');
    await page.click('[data-category="all"]');
    assert.equal((await visible()).length, 4);
    // kategori tanpa produk tidak ditampilkan sebagai tombol
    assert.equal(await page.locator('[data-category]').count(), 4); // Semua + makanan + minuman + jajanan
    await page.context().close();
  });

  await scenario('Keranjang: tambah, ubah jumlah, batas stok, hapus (dengan konfirmasi), simpan setelah reload', async () => {
    const page = await newPage();
    const nasi = await productId('Nasi Uji');
    const es = await productId('Es Terbatas');

    await addButton(page, nasi).click();
    await addButton(page, nasi).click();
    await addButton(page, es).click();
    assert.equal(await page.locator('#cart-count').innerText(), '3');

    await page.click('#cart-btn');
    assert.equal(await page.locator('.cart-item').count(), 2);
    assert.equal(await page.locator('#cart-total-price').innerText(), money(2 * 20000 + 5000));

    // tambah jumlah Es sampai batas stok (3)
    const plusEs = page.locator(`[data-action="plus"][data-id="${es}"]`);
    await plusEs.click();
    await plusEs.click();
    assert.equal(await page.locator(`.cart-item[data-id="${es}"] .quantity-number`).innerText(), '3');
    await plusEs.click(); // melewati stok -> ditolak
    assert.equal(await page.locator(`.cart-item[data-id="${es}"] .quantity-number`).innerText(), '3');
    assert.match(await page.locator('#toast-message').innerText(), /Stok/);

    // kurangi
    await page.locator(`[data-action="minus"][data-id="${es}"]`).click();
    assert.equal(await page.locator(`.cart-item[data-id="${es}"] .quantity-number`).innerText(), '2');

    // hapus: batal dulu, lalu konfirmasi
    await page.locator(`[data-action="remove"][data-id="${es}"]`).click();
    await page.click('#confirm-cancel');
    assert.equal(await page.locator('.cart-item').count(), 2);
    await page.locator(`[data-action="remove"][data-id="${es}"]`).click();
    await page.click('#confirm-ok');
    // Penghapusan selesai SETELAH dialog menutup (asinkron): tunggu hasilnya, jangan membaca DOM seketika.
    await page.waitForFunction(() => document.querySelectorAll('.cart-item').length === 1, null, { timeout: 5000 });
    assert.equal(await page.locator('.cart-item').count(), 1);
    assert.equal(await page.locator('#cart-total-price').innerText(), money(40000));

    // keranjang bertahan setelah reload
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu-card:not(.skeleton)');
    assert.equal(await page.locator('#cart-count').innerText(), '2');

    // kosongkan
    await page.click('#cart-btn');
    await page.click('#clear-cart-btn');
    await page.click('#confirm-ok');
    await page.waitForFunction(() => document.querySelector('#cart-items').innerText.includes('Keranjang masih kosong'), null, { timeout: 5000 });
    assert.match(await page.locator('#cart-items').innerText(), /Keranjang masih kosong/);
    assert.equal(await page.locator('#checkout-btn').isDisabled(), true);
    assert.deepEqual(page.problems, []);
    await page.context().close();
  });

  await scenario('Detail produk: pilih jumlah lalu tambah ke keranjang', async () => {
    const page = await newPage();
    const nasi = await productId('Nasi Uji');
    await page.locator(`[data-detail="${nasi}"]`).click();
    await page.waitForSelector('#product-dialog[open]');
    assert.equal(await page.locator('#product-dialog-title').innerText(), 'Nasi Uji');
    await page.click('#pd-plus');
    await page.click('#pd-plus');
    assert.equal(await page.locator('#pd-qty').innerText(), '3');
    await page.click('#pd-add');
    assert.equal(await page.locator('#cart-count').innerText(), '3');
    await page.context().close();
  });

  await scenario('Checkout: validasi formulir menolak data kosong/salah (tanpa memanggil server)', async () => {
    const page = await newPage();
    await addButton(page, await productId('Nasi Uji')).click();
    await page.click('#cart-btn');
    await page.click('#checkout-btn');
    await page.waitForSelector('#checkout-dialog[open]');
    const before = await orderCount();
    await page.fill('#co-phone', '12345');
    await page.click('#co-submit');
    assert.match(await page.locator('#co-name-error').innerText(), /minimal 2/);
    assert.match(await page.locator('#co-phone-error').innerText(), /tidak valid/);
    await page.check('input[name="fulfillment_method"][value="delivery"]');
    assert.equal(await page.locator('#co-address-field').isVisible(), true);
    await page.fill('#co-name', 'Siti');
    await page.fill('#co-phone', '081234567890');
    await page.click('#co-submit');
    assert.match(await page.locator('#co-address-error').innerText(), /minimal 10/);
    // total berubah: ongkir tampil
    assert.equal(await page.locator('#co-total').innerText(), money(25000));
    assert.equal(await orderCount(), before, 'tidak boleh ada pesanan tersimpan');
    await page.context().close();
  });

  await scenario('ALUR UTAMA: pilih menu -> checkout -> pesanan TERSIMPAN di MySQL -> nomor pesanan tampil', async () => {
    const page = await newPage();
    const nasi = await productId('Nasi Uji');
    const es = await productId('Es Terbatas');
    const stockBefore = await stockOf('Es Terbatas');
    const ordersBefore = await orderCount();

    await addButton(page, nasi).click();
    await addButton(page, nasi).click();
    await addButton(page, es).click();
    await page.click('#cart-btn');
    await page.click('#checkout-btn');
    await page.waitForSelector('#checkout-dialog[open]');
    await fillCheckout(page, { name: 'Budi Uji', phone: '0812-3456-7890', delivery: true, payment: 'bank_transfer', notes: 'Tanpa sambal' });
    assert.match(await page.locator('#co-payment-info').innerText(), /Bank Uji/);
    assert.equal(await page.locator('#co-total').innerText(), money(2 * 20000 + 5000 + 5000));
    await page.click('#co-submit');

    await page.waitForSelector('#checkout-success:not([hidden])');
    const number = await page.locator('#success-number').innerText();
    assert.match(number, /^RB-\d{6}-[A-Z0-9]{5}$/);
    assert.equal(await page.locator('#success-total').innerText(), money(50000));

    // BUKTI: benar-benar ada di database dengan angka dari SERVER
    const [orders] = await pool.query('SELECT * FROM orders WHERE order_number = ?', [number]);
    assert.equal(orders.length, 1, 'pesanan harus ada di database');
    const order = orders[0];
    assert.equal(order.customer_name, 'Budi Uji');
    assert.equal(order.customer_phone, '6281234567890');
    assert.equal(order.subtotal, 45000);
    assert.equal(order.delivery_fee, 5000);
    assert.equal(order.total, 50000);
    assert.equal(order.order_status, 'pending');
    assert.equal(order.payment_status, 'unpaid', 'membuka/mengirim pesanan tidak boleh otomatis dianggap lunas');
    assert.equal(order.payment_method, 'bank_transfer');
    const [items] = await pool.query('SELECT product_name_snapshot AS n, quantity AS q FROM order_items WHERE order_id = ? ORDER BY id', [order.id]);
    assert.deepEqual(items.map((i) => `${i.q}x ${i.n}`).sort(), ['1x Es Terbatas', '2x Nasi Uji']);
    assert.equal(await orderCount(), ordersBefore + 1);
    assert.equal(await stockOf('Es Terbatas'), stockBefore - 1, 'stok produk yang dihitung harus berkurang');

    // keranjang dikosongkan HANYA setelah server menyimpan
    assert.equal(await page.locator('#cart-count').isHidden(), true);
    // tautan WhatsApp memakai nomor pengaturan & data pesanan dari server
    const href = await page.locator('#success-whatsapp').getAttribute('href');
    // Nomor yang dipakai = nomor di pengaturan SAAT INI (skenario admin boleh mengubahnya), bukan angka yang di-hardcode.
    const [[{ setting_value: configuredWhatsapp }]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'whatsapp_number'");
    assert.ok(/^62\d{8,13}$/.test(configuredWhatsapp));
    assert.equal(href.split('?')[0], `https://wa.me/${configuredWhatsapp}`);
    assert.ok(href.includes('?text='));
    assert.ok(decodeURIComponent(href).includes(number));
    assert.deepEqual(page.problems, []);
    await page.context().close();
  });

  await scenario('Harga dimanipulasi: harga di localStorage & total palsu tidak dipercaya server', async () => {
    const page = await newPage();
    const nasi = await productId('Nasi Uji');
    // (a) manipulasi localStorage: tambahkan "price" palsu dan jumlah aneh
    await page.evaluate((id) => {
      localStorage.setItem('royalBites.cart.v2', JSON.stringify([{ id, qty: 2, price: 1, name: 'Gratis' }]));
    }, nasi);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu-card:not(.skeleton)');
    await page.click('#cart-btn');
    assert.equal(await page.locator('#cart-total-price').innerText(), money(40000), 'tampilan memakai harga katalog');

    // (b) manipulasi permintaan: ubah expected_total menjadi Rp1 di tengah jalan
    await page.route('**/api/orders', async (route) => {
      const body = JSON.parse(route.request().postData());
      body.expected_total = 1;
      await route.continue({ postData: JSON.stringify(body) });
    });
    const before = await orderCount();
    await page.click('#checkout-btn');
    await page.waitForSelector('#checkout-dialog[open]');
    await fillCheckout(page, { name: 'Penipu Harga', phone: '081200000001' });
    await page.click('#co-submit');
    await page.waitForSelector('#checkout-alert:not([hidden])');
    assert.match(await page.locator('#checkout-alert').innerText(), /Harga atau ongkos kirim berubah/);
    assert.equal(await page.locator('#checkout-success').isHidden(), true, 'tidak boleh tampil sukses');
    assert.equal(await orderCount(), before, 'pesanan tidak boleh tersimpan');

    // (c) tanpa manipulasi, pesanan tersimpan dengan harga SERVER (Rp40.000, bukan Rp2)
    await page.unroute('**/api/orders');
    await page.click('#co-submit');
    await page.waitForSelector('#checkout-success:not([hidden])');
    const number = await page.locator('#success-number').innerText();
    const [[row]] = await pool.query('SELECT total FROM orders WHERE order_number = ?', [number]);
    assert.equal(row.total, 40000);
    await page.context().close();
  });

  await scenario('Stok kurang: server menolak (CART_INVALID), keranjang disesuaikan, tidak ada pesanan setengah jadi', async () => {
    const page = await newPage();
    const es = await productId('Es Terbatas');
    const stock = await stockOf('Es Terbatas'); // sisa dari skenario sebelumnya (2)
    assert.ok(stock >= 2, `butuh stok >= 2 untuk skenario ini, ada ${stock}`);

    // Pelanggan melihat katalog "basi" (stok masih tampak cukup) — meniru pembeli lain yang lebih cepat.
    const snapshot = await (await fetch(`${baseUrl}/api/products`)).json();
    await page.route('**/api/products', (route) => route.fulfill({ json: snapshot }));

    await page.evaluate(({ id, qty }) => localStorage.setItem('royalBites.cart.v2', JSON.stringify([{ id, qty }])), { id: es, qty: stock });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu-card:not(.skeleton)');

    // Pembeli lain mengambil stok sampai tersisa 1 (lewat API sungguhan).
    const rival = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ product_id: es, quantity: stock - 1 }],
        customer_name: 'Pembeli Lain',
        customer_phone: '081299990000',
        fulfillment_method: 'pickup',
        payment_method: 'cod',
        expected_total: (stock - 1) * 5000,
        idempotency_key: crypto.randomUUID(),
      }),
    });
    assert.equal(rival.status, 201);
    assert.equal(await stockOf('Es Terbatas'), 1);

    const before = await orderCount();
    await page.click('#cart-btn');
    await page.click('#checkout-btn');
    await page.waitForSelector('#checkout-dialog[open]');
    await fillCheckout(page, { name: 'Pembeli Lambat', phone: '081200000002' });
    await page.click('#co-submit');
    await page.waitForSelector('#checkout-alert:not([hidden])');
    const alertText = await page.locator('#checkout-alert').innerText();
    assert.match(alertText, /disesuaikan dengan stok terbaru/);
    assert.match(alertText, /tinggal 1|Stok/i);
    assert.equal(await page.locator('#checkout-success').isHidden(), true);
    assert.equal(await orderCount(), before, 'tidak boleh ada pesanan tersimpan');
    assert.equal(await stockOf('Es Terbatas'), 1, 'stok tidak boleh berubah karena pesanan yang ditolak');

    // Setelah disesuaikan (jumlah 1), pesanan bisa dilanjutkan.
    await page.unroute('**/api/products');
    await page.click('#co-submit');
    await page.waitForSelector('#checkout-success:not([hidden])');
    assert.equal(await stockOf('Es Terbatas'), 0);
    await page.context().close();
  });

  await scenario('Produk habis di keranjang diblokir sebelum checkout', async () => {
    const page = await newPage();
    const es = await productId('Es Terbatas'); // stok sekarang 0
    await page.evaluate((id) => localStorage.setItem('royalBites.cart.v2', JSON.stringify([{ id, qty: 1 }])), es);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu-card:not(.skeleton)');
    // keranjang disesuaikan otomatis: item yang tidak bisa dipesan lagi tidak boleh lolos
    await page.click('#cart-btn');
    assert.equal(await page.locator('#checkout-btn').isDisabled(), true);
    await page.context().close();
  });

  await scenario('Klik berulang/cepat pada "Buat Pesanan" hanya membuat SATU pesanan', async () => {
    const page = await newPage();
    const nasi = await productId('Nasi Uji');
    await addButton(page, nasi).click();
    await page.click('#cart-btn');
    await page.click('#checkout-btn');
    await page.waitForSelector('#checkout-dialog[open]');
    await fillCheckout(page, { name: 'Klik Banyak', phone: '081200000003' });

    // Perlambat server agar klik berikutnya pasti terjadi saat permintaan pertama masih berjalan.
    let posts = 0;
    await page.route('**/api/orders', async (route) => {
      posts += 1;
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });
    const before = await orderCount();
    await page.evaluate(() => {
      const button = document.querySelector('#co-submit');
      for (let i = 0; i < 6; i += 1) button.click();
      document.querySelector('#checkout-form').requestSubmit();
    });
    await page.waitForSelector('#checkout-success:not([hidden])');
    assert.equal(posts, 1, `hanya 1 permintaan boleh dikirim, terkirim ${posts}`);
    assert.equal(await orderCount(), before + 1);
    await page.context().close();
  });

  await scenario('Koneksi putus SETELAH server menyimpan: coba lagi tidak membuat pesanan ganda (idempotensi)', async () => {
    const page = await newPage();
    const nasi = await productId('Nasi Uji');
    await addButton(page, nasi).click();
    await page.click('#cart-btn');
    await page.click('#checkout-btn');
    await page.waitForSelector('#checkout-dialog[open]');
    await fillCheckout(page, { name: 'Sinyal Buruk', phone: '081200000004' });

    // Permintaan pertama sampai ke server (tersimpan), tetapi balasannya "hilang".
    let first = true;
    await page.route('**/api/orders', async (route) => {
      if (first) {
        first = false;
        await route.fetch(); // server memproses & menyimpan
        await route.abort('connectionreset'); // browser tidak pernah menerima balasannya
      } else {
        await route.continue();
      }
    });
    const before = await orderCount();
    await page.click('#co-submit');
    await page.waitForSelector('#checkout-alert:not([hidden])');
    assert.match(await page.locator('#checkout-alert').innerText(), /belum bisa memastikan pesanan tersimpan/);
    assert.equal(await page.locator('#checkout-success').isHidden(), true, 'tidak boleh klaim sukses tanpa balasan server');
    assert.equal(await orderCount(), before + 1, 'server memang sudah menyimpan satu pesanan');

    await page.click('#co-submit'); // coba lagi
    await page.waitForSelector('#checkout-success:not([hidden])');
    assert.equal(await orderCount(), before + 1, 'tidak boleh ada pesanan ganda');
    const number = await page.locator('#success-number').innerText();
    const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM orders WHERE order_number = ?', [number]);
    assert.equal(row.n, 1);
    await page.context().close();
  });

  await scenario('Server mati/DB error: pelanggan mendapat pesan ramah, bukan sukses palsu', async () => {
    const page = await newPage();
    await addButton(page, await productId('Nasi Uji')).click();
    await page.click('#cart-btn');
    await page.click('#checkout-btn');
    await page.waitForSelector('#checkout-dialog[open]');
    await fillCheckout(page, { name: 'Server Error', phone: '081200000005' });
    await page.route('**/api/orders', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan pada server. Silakan coba lagi.' } } }),
    );
    await page.click('#co-submit');
    await page.waitForSelector('#checkout-alert:not([hidden])');
    assert.match(await page.locator('#checkout-alert').innerText(), /Terjadi kesalahan pada server/);
    assert.equal(await page.locator('#checkout-success').isHidden(), true);
    assert.equal(await page.locator('#cart-count').isHidden(), false, 'keranjang jangan dikosongkan saat gagal');
    await page.context().close();
  });

  await scenario('Formulir kontak: pesan tersimpan di database; validasi & honeypot bekerja', async () => {
    const page = await newPage();
    await page.fill('#contact-name', 'Tamu');
    await page.fill('#contact-message', 'abc'); // terlalu pendek
    await page.click('#contact-submit');
    assert.match(await page.locator('#contact-message-error').innerText(), /minimal 5/);

    await page.fill('#contact-message', 'Halo, apakah buka hari Minggu?');
    await page.fill('#contact-email', 'tamu@example.com');
    await page.click('#contact-submit');
    await page.waitForFunction(() => document.querySelector('#contact-feedback').textContent.includes('Pesan terkirim'));
    const [rows] = await pool.query("SELECT name, email, message FROM contact_messages WHERE message LIKE 'Halo, apakah%'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, 'tamu@example.com');

    // honeypot terisi (bot): server menolak, tidak menyimpan
    await page.evaluate(() => { document.querySelector('#contact-website').value = 'http://spam.example'; });
    await page.fill('#contact-name', 'Bot');
    await page.fill('#contact-message', 'Beli obat murah sekarang juga');
    await page.click('#contact-submit');
    await page.waitForFunction(() => document.querySelector('#contact-feedback').classList.contains('err'));
    const [spam] = await pool.query("SELECT 1 FROM contact_messages WHERE message LIKE 'Beli obat%'");
    assert.equal(spam.length, 0);
    await page.context().close();
  });

  await scenario('Responsif: tidak ada geser horizontal pada 320 / 390 / 768 / 1440 px', async () => {
    for (const width of [320, 390, 768, 1440]) {
      const page = await newPage({ width, height: 800 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `lebar ${width}px: ada geser horizontal ${overflow}px`);
      await page.click('#cart-btn');
      const drawerOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(drawerOverflow <= 0, `lebar ${width}px (keranjang terbuka): geser horizontal ${drawerOverflow}px`);
      await page.context().close();
    }
  });
}
