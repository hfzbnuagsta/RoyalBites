// Test integrasi alur pemesanan pelanggan: server + MySQL sungguhan.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  clearData,
  countRows,
  insertProduct,
  orderPayload,
  prepareDatabase,
  setSettings,
  startTestServer,
  stockOf,
} from '../helpers.js';

let ctx;
let client;

before(async () => {
  ctx = await startTestServer();
  await prepareDatabase(ctx.config);
  client = ctx.client();
});
after(() => ctx.stop());
beforeEach(() => clearData(ctx.pool));

const postOrder = (payload) => client.post('/api/orders', payload);

describe('pemesanan: alur normal', () => {
  test('membuat pesanan, harga dari database, stok tracked berkurang, stok tak-tracked tidak', async () => {
    const tracked = await insertProduct(ctx.pool, { name: 'Mie Lendir', price: 15000, stock: 10, track_stock: 1 });
    const free = await insertProduct(ctx.pool, { name: 'Es Teh', price: 5000, track_stock: 0 });

    const response = await postOrder(
      orderPayload([
        { product_id: tracked.id, quantity: 2, price: 15000 },
        { product_id: free.id, quantity: 3, price: 5000 },
      ]),
    );

    assert.equal(response.status, 201);
    const { order, replayed } = response.data;
    assert.equal(replayed, false);
    assert.match(order.order_number, /^RB-\d{6}-[A-HJ-NP-Z2-9]{5}$/);
    assert.equal(order.subtotal, 45000);
    assert.equal(order.delivery_fee, 0);
    assert.equal(order.discount, 0);
    assert.equal(order.total, 45000);
    assert.equal(order.order_status, 'pending');
    assert.equal(order.payment_status, 'unpaid');
    assert.equal(order.customer_phone, '6281234567890'); // dinormalisasi
    assert.deepEqual(
      order.items.map((i) => [i.name, i.unit_price, i.quantity, i.line_total]),
      [
        ['Mie Lendir', 15000, 2, 30000],
        ['Es Teh', 5000, 3, 15000],
      ],
    );
    assert.equal(await stockOf(ctx.pool, tracked.id), 8);
    assert.equal(await stockOf(ctx.pool, free.id), 0);
    assert.equal(await countRows(ctx.pool, 'order_events'), 1);
  });

  test('respons pelanggan tidak membocorkan ID internal atau data admin', async () => {
    const p = await insertProduct(ctx.pool);
    const { data } = await postOrder(orderPayload([{ product_id: p.id, quantity: 1, price: p.price }]));
    for (const key of ['id', 'updated_at', 'cancel_reason', 'request_hash', 'idempotency_key']) {
      assert.equal(Object.hasOwn(data.order, key), false, `field ${key} tidak boleh ada`);
    }
  });

  test('item dengan product_id sama digabung', async () => {
    const p = await insertProduct(ctx.pool, { price: 7000, stock: 10, track_stock: 1 });
    const { status, data } = await postOrder(
      orderPayload([
        { product_id: p.id, quantity: 2, price: 7000 },
        { product_id: p.id, quantity: 3, price: 7000 },
      ]),
    );
    assert.equal(status, 201);
    assert.equal(data.order.items.length, 1);
    assert.equal(data.order.items[0].quantity, 5);
    assert.equal(data.order.total, 35000);
    assert.equal(await stockOf(ctx.pool, p.id), 5);
  });

  test('nama berisi HTML/SQL disimpan apa adanya sebagai teks (bukan dieksekusi)', async () => {
    const p = await insertProduct(ctx.pool, { price: 1000 });
    const name = `<img src=x onerror=alert(1)> ' OR 1=1; DROP TABLE orders; --`;
    const { status, data } = await postOrder(
      orderPayload([{ product_id: p.id, quantity: 1, price: 1000 }], { customer_name: name, customer_notes: "'); DELETE FROM products; --" }),
    );
    assert.equal(status, 201);
    assert.equal(data.order.customer_name, name);
    assert.equal(await countRows(ctx.pool, 'products'), 1);
    assert.equal(await countRows(ctx.pool, 'orders'), 1);
  });
});

describe('pemesanan: harga dan total tidak dipercaya dari browser', () => {
  test('field harga/diskon/total tambahan dari browser diabaikan', async () => {
    const p = await insertProduct(ctx.pool, { price: 20000 });
    const payload = orderPayload([{ product_id: p.id, quantity: 1, price: 20000 }], {
      discount: 19000,
      subtotal: 1,
      total: 1,
      delivery_fee: 0,
    });
    payload.items[0].unit_price = 1;
    payload.items[0].price = 1;
    const { status, data } = await postOrder(payload);
    assert.equal(status, 201);
    assert.equal(data.order.total, 20000);
    assert.equal(data.order.discount, 0);
    assert.equal(data.order.items[0].unit_price, 20000);
  });

  test('expected_total yang dimanipulasi (lebih murah) ditolak 409 PRICE_CHANGED dan tidak ada pesanan', async () => {
    const p = await insertProduct(ctx.pool, { price: 20000, stock: 5, track_stock: 1 });
    const { status, data } = await postOrder(orderPayload([{ product_id: p.id, quantity: 1, price: 1 }]));
    assert.equal(status, 409);
    assert.equal(data.error.code, 'PRICE_CHANGED');
    assert.equal(data.error.details.total, 20000);
    assert.equal(await countRows(ctx.pool, 'orders'), 0);
    assert.equal(await stockOf(ctx.pool, p.id), 5);
  });

  test('harga berubah setelah pelanggan memasukkan ke keranjang => 409 dengan total terbaru', async () => {
    const p = await insertProduct(ctx.pool, { price: 10000 });
    const payload = orderPayload([{ product_id: p.id, quantity: 2, price: 10000 }]);
    await ctx.pool.execute('UPDATE products SET price = 12000 WHERE id = ?', [p.id]);
    const { status, data } = await postOrder(payload);
    assert.equal(status, 409);
    assert.equal(data.error.code, 'PRICE_CHANGED');
    assert.equal(data.error.details.total, 24000);
    assert.equal(await countRows(ctx.pool, 'orders'), 0);
  });

  test('harga di riwayat pesanan tetap (snapshot) walau harga produk berubah kemudian', async () => {
    const p = await insertProduct(ctx.pool, { price: 10000 });
    const { data } = await postOrder(orderPayload([{ product_id: p.id, quantity: 1, price: 10000 }]));
    await ctx.pool.execute('UPDATE products SET price = 99999, name = "Nama Baru" WHERE id = ?', [p.id]);
    const [[row]] = await ctx.pool.query('SELECT product_name_snapshot, unit_price_snapshot FROM order_items');
    assert.equal(row.unit_price_snapshot, 10000);
    assert.notEqual(row.product_name_snapshot, 'Nama Baru');
    assert.equal(data.order.total, 10000);
  });
});

describe('pemesanan: stok dan ketersediaan', () => {
  test('stok tidak cukup => 409 CART_INVALID, tidak ada pesanan, stok tetap', async () => {
    const p = await insertProduct(ctx.pool, { price: 5000, stock: 2, track_stock: 1 });
    const { status, data } = await postOrder(orderPayload([{ product_id: p.id, quantity: 3, price: 5000 }]));
    assert.equal(status, 409);
    assert.equal(data.error.code, 'CART_INVALID');
    assert.deepEqual(
      data.error.details.problems.map((x) => [x.code, x.requested, x.available]),
      [['INSUFFICIENT_STOCK', 3, 2]],
    );
    assert.equal(await countRows(ctx.pool, 'orders'), 0);
    assert.equal(await stockOf(ctx.pool, p.id), 2);
  });

  test('semua masalah keranjang dilaporkan sekaligus (habis, nonaktif, dihapus, tidak ada)', async () => {
    const soldOut = await insertProduct(ctx.pool, { stock: 0, track_stock: 1 });
    const disabled = await insertProduct(ctx.pool, { is_available: 0 });
    const deleted = await insertProduct(ctx.pool);
    await ctx.pool.execute('UPDATE products SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [deleted.id]);
    const ok = await insertProduct(ctx.pool, { price: 1000 });

    const { status, data } = await postOrder(
      orderPayload([
        { product_id: soldOut.id, quantity: 1, price: 10000 },
        { product_id: disabled.id, quantity: 1, price: 10000 },
        { product_id: deleted.id, quantity: 1, price: 10000 },
        { product_id: 999999, quantity: 1, price: 10000 },
        { product_id: ok.id, quantity: 1, price: 1000 },
      ]),
    );
    assert.equal(status, 409);
    const codes = Object.fromEntries(data.error.details.problems.map((x) => [x.product_id, x.code]));
    assert.deepEqual(codes, {
      [soldOut.id]: 'OUT_OF_STOCK',
      [disabled.id]: 'UNAVAILABLE',
      [deleted.id]: 'NOT_FOUND',
      999999: 'NOT_FOUND',
    });
    assert.equal(await countRows(ctx.pool, 'orders'), 0);
  });

  test('stok terakhir: 10 pembeli berebut 5 stok => tepat 5 berhasil, stok 0, tidak oversell', async () => {
    const p = await insertProduct(ctx.pool, { price: 8000, stock: 5, track_stock: 1 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => postOrder(orderPayload([{ product_id: p.id, quantity: 1, price: 8000 }]))),
    );
    const created = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 409).length;
    assert.equal(created, 5);
    assert.equal(rejected, 5);
    assert.equal(await stockOf(ctx.pool, p.id), 0);
    assert.equal(await countRows(ctx.pool, 'orders'), 5);
  });
});

describe('pemesanan: klik ganda / retry (idempotency)', () => {
  test('key sama dikirim dua kali berurutan => pesanan yang sama, stok berkurang sekali', async () => {
    const p = await insertProduct(ctx.pool, { price: 5000, stock: 10, track_stock: 1 });
    const payload = orderPayload([{ product_id: p.id, quantity: 2, price: 5000 }]);
    const first = await postOrder(payload);
    const second = await postOrder(payload);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.data.replayed, true);
    assert.equal(second.data.order.order_number, first.data.order.order_number);
    assert.equal(await countRows(ctx.pool, 'orders'), 1);
    assert.equal(await stockOf(ctx.pool, p.id), 8);
  });

  test('8 request identik bersamaan => hanya 1 pesanan, semua respons merujuk pesanan yang sama', async () => {
    const p = await insertProduct(ctx.pool, { price: 5000, stock: 10, track_stock: 1 });
    const payload = orderPayload([{ product_id: p.id, quantity: 3, price: 5000 }]);
    const results = await Promise.all(Array.from({ length: 8 }, () => postOrder(payload)));
    assert.deepEqual([...new Set(results.map((r) => r.status))].sort(), [200, 201]);
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(new Set(results.map((r) => r.data.order.order_number)).size, 1);
    assert.equal(await countRows(ctx.pool, 'orders'), 1);
    assert.equal(await stockOf(ctx.pool, p.id), 7);
  });

  test('retry saat stok tinggal pas: request kalah tetap mendapat pesanan yang sama (bukan "stok habis")', async () => {
    const p = await insertProduct(ctx.pool, { price: 5000, stock: 1, track_stock: 1 });
    const payload = orderPayload([{ product_id: p.id, quantity: 1, price: 5000 }]);
    const results = await Promise.all(Array.from({ length: 6 }, () => postOrder(payload)));
    assert.ok(results.every((r) => r.status === 200 || r.status === 201), JSON.stringify(results.map((r) => r.status)));
    assert.equal(new Set(results.map((r) => r.data.order.order_number)).size, 1);
    assert.equal(await stockOf(ctx.pool, p.id), 0);
  });

  test('key sama tetapi isi berbeda => 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const p = await insertProduct(ctx.pool, { price: 5000 });
    const payload = orderPayload([{ product_id: p.id, quantity: 1, price: 5000 }]);
    await postOrder(payload);
    const tampered = { ...payload, items: [{ product_id: p.id, quantity: 2 }], expected_total: 10000 };
    const { status, data } = await postOrder(tampered);
    assert.equal(status, 422);
    assert.equal(data.error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(await countRows(ctx.pool, 'orders'), 1);
  });

  test('key harus berupa UUID', async () => {
    const p = await insertProduct(ctx.pool, { price: 5000 });
    const { status, data } = await postOrder(orderPayload([{ product_id: p.id, quantity: 1, price: 5000 }], { idempotency_key: "1' OR '1'='1" }));
    assert.equal(status, 400);
    assert.ok(data.error.details.fields.idempotency_key);
  });
});

describe('pemesanan: validasi input', () => {
  let p;
  beforeEach(async () => {
    p = await insertProduct(ctx.pool, { price: 5000, stock: 10, track_stock: 1 });
  });
  const base = () => orderPayload([{ product_id: p.id, quantity: 1, price: 5000 }]);

  for (const quantity of [0, -1, 1.5, '2', null, 100, 1e9]) {
    test(`quantity ${JSON.stringify(quantity)} ditolak`, async () => {
      const payload = base();
      payload.items[0].quantity = quantity;
      const { status, data } = await postOrder(payload);
      assert.equal(status, 400);
      assert.equal(data.error.code, 'VALIDATION_ERROR');
      assert.equal(await countRows(ctx.pool, 'orders'), 0);
    });
  }

  for (const productId of ['1 OR 1=1', -5, 0, 1.2, null, '../etc/passwd']) {
    test(`product_id ${JSON.stringify(productId)} ditolak`, async () => {
      const payload = base();
      payload.items[0].product_id = productId;
      assert.equal((await postOrder(payload)).status, 400);
    });
  }

  test('keranjang kosong / bukan array / terlalu banyak jenis menu ditolak', async () => {
    assert.equal((await postOrder({ ...base(), items: [] })).status, 400);
    assert.equal((await postOrder({ ...base(), items: 'abc' })).status, 400);
    const many = Array.from({ length: 31 }, (_, i) => ({ product_id: i + 1, quantity: 1 }));
    assert.equal((await postOrder({ ...base(), items: many })).status, 400);
  });

  test('nama & nomor telepon wajib dan valid', async () => {
    const noName = await postOrder({ ...base(), customer_name: ' ' });
    assert.equal(noName.status, 400);
    assert.ok(noName.data.error.details.fields.customer_name);
    const badPhone = await postOrder({ ...base(), customer_phone: '12345' });
    assert.equal(badPhone.status, 400);
    assert.ok(badPhone.data.error.details.fields.customer_phone);
  });

  test('metode bayar & pengambilan tidak dikenal ditolak', async () => {
    assert.equal((await postOrder({ ...base(), payment_method: 'bitcoin' })).status, 400);
    assert.equal((await postOrder({ ...base(), fulfillment_method: 'drone' })).status, 400);
  });

  test('JSON rusak => 400 INVALID_JSON, body terlalu besar => 413', async () => {
    const broken = await client.request('POST', '/api/orders', { body: '{"items": [', headers: { 'content-type': 'application/json' } });
    assert.equal(broken.status, 400);
    assert.equal(broken.data.error.code, 'INVALID_JSON');
    const huge = await client.request('POST', '/api/orders', {
      body: JSON.stringify({ customer_notes: 'x'.repeat(30_000) }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(huge.status, 413);
  });
});

describe('pemesanan: aturan bisnis dari pengaturan', () => {
  test('pesanan ditutup => 409 ORDERS_CLOSED', async () => {
    const p = await insertProduct(ctx.pool, { price: 5000 });
    await setSettings(ctx.pool, { accepting_orders: false });
    const { status, data } = await postOrder(orderPayload([{ product_id: p.id, quantity: 1, price: 5000 }]));
    assert.equal(status, 409);
    assert.equal(data.error.code, 'ORDERS_CLOSED');
  });

  test('minimum pemesanan', async () => {
    const p = await insertProduct(ctx.pool, { price: 5000 });
    await setSettings(ctx.pool, { min_order_amount: 20000 });
    const low = await postOrder(orderPayload([{ product_id: p.id, quantity: 2, price: 5000 }]));
    assert.equal(low.status, 409);
    assert.equal(low.data.error.code, 'MIN_ORDER_NOT_MET');
    const enough = await postOrder(orderPayload([{ product_id: p.id, quantity: 4, price: 5000 }]));
    assert.equal(enough.status, 201);
  });

  test('pengantaran ditolak jika belum diaktifkan', async () => {
    const p = await insertProduct(ctx.pool, { price: 5000 });
    const payload = orderPayload([{ product_id: p.id, quantity: 1, price: 5000 }], {
      fulfillment_method: 'delivery',
      delivery_address: 'Jl. Mawar No. 5, Bekasi',
    });
    const { status, data } = await postOrder(payload);
    assert.equal(status, 400);
    assert.ok(data.error.details.fields.fulfillment_method);
  });

  test('pengantaran: ongkir dari pengaturan server, alamat wajib', async () => {
    const p = await insertProduct(ctx.pool, { price: 5000 });
    await setSettings(ctx.pool, { delivery_enabled: true, delivery_fee: 7000 });

    const noAddress = await postOrder(orderPayload([{ product_id: p.id, quantity: 1, price: 5000 }], { fulfillment_method: 'delivery', expected_total: 12000 }));
    assert.equal(noAddress.status, 400);
    assert.ok(noAddress.data.error.details.fields.delivery_address);

    const ok = await postOrder(
      orderPayload([{ product_id: p.id, quantity: 1, price: 5000 }], {
        fulfillment_method: 'delivery',
        delivery_address: 'Jl. Mawar No. 5, Bekasi',
        expected_total: 12000,
        delivery_fee: 0, // browser mencoba menggratiskan ongkir
      }),
    );
    assert.equal(ok.status, 201);
    assert.equal(ok.data.order.delivery_fee, 7000);
    assert.equal(ok.data.order.total, 12000);

    // Browser mengira total tanpa ongkir => ditolak sebagai harga berubah
    const stale = await postOrder(
      orderPayload([{ product_id: p.id, quantity: 1, price: 5000 }], {
        fulfillment_method: 'delivery',
        delivery_address: 'Jl. Mawar No. 5, Bekasi',
        expected_total: 5000,
      }),
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error.code, 'PRICE_CHANGED');
  });

  test('ambil sendiri: alamat diabaikan dan tidak disimpan, ongkir 0', async () => {
    const p = await insertProduct(ctx.pool, { price: 5000 });
    await setSettings(ctx.pool, { delivery_enabled: true, delivery_fee: 7000 });
    const { data } = await postOrder(
      orderPayload([{ product_id: p.id, quantity: 1, price: 5000 }], { delivery_address: 'Jl. Rahasia 1' }),
    );
    assert.equal(data.order.delivery_fee, 0);
    assert.equal(data.order.delivery_address, null);
  });

  test('transfer manual hanya jika diaktifkan; COD bisa dinonaktifkan', async () => {
    const p = await insertProduct(ctx.pool, { price: 5000 });
    const transfer = orderPayload([{ product_id: p.id, quantity: 1, price: 5000 }], { payment_method: 'bank_transfer' });
    assert.equal((await postOrder(transfer)).status, 400);

    await setSettings(ctx.pool, { payment_transfer_enabled: true, payment_transfer_instructions: 'Bank X 123 a.n. Toko', payment_cod_enabled: false });
    const nowOk = await postOrder({ ...transfer, idempotency_key: crypto.randomUUID() });
    assert.equal(nowOk.status, 201);
    assert.equal(nowOk.data.order.payment_status, 'unpaid'); // membuat pesanan TIDAK berarti sudah dibayar

    const cod = await postOrder(orderPayload([{ product_id: p.id, quantity: 1, price: 5000 }]));
    assert.equal(cod.status, 400);
  });
});

describe('nomor pesanan bentrok', () => {
  test('jika nomor acak kebetulan sudah dipakai pesanan lain, pembuatan diulang dengan nomor baru (tanpa error ke pelanggan)', async () => {
    const product = await insertProduct(ctx.pool, { price: 10000, stock: 10, track_stock: 1 });
    const original = crypto.randomBytes;
    let forcedDraws = 2; // dua pengundian nomor pertama (5 byte) dipaksa identik => pesanan kedua pasti bentrok sekali
    crypto.randomBytes = (size, ...rest) => (size === 5 && forcedDraws-- > 0 ? Buffer.from([1, 2, 3, 4, 5]) : original(size, ...rest));
    try {
      const first = await postOrder(orderPayload([{ product_id: product.id, quantity: 1, price: 10000 }]));
      const second = await postOrder(orderPayload([{ product_id: product.id, quantity: 1, price: 10000 }]));
      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.notEqual(first.data.order.order_number, second.data.order.order_number);
      assert.equal(await countRows(ctx.pool, 'orders'), 2);
      assert.equal(await stockOf(ctx.pool, product.id), 8, 'percobaan yang bentrok tidak mengurangi stok dua kali');
    } finally {
      crypto.randomBytes = original;
    }
  });
});
