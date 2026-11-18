// Dashboard admin Royal Bites.
// Semua data berasal dari API (/api/admin/...) dan semua tampilan dibuat dengan DOM API (textContent),
// bukan innerHTML, sehingga isi database (nama pelanggan, catatan, dll.) tidak bisa menyisipkan skrip.
import { formatRupiah, h, placeholderFor } from "/js/format.js";
import { closeDialog, confirmAction, initDialogs, openDialog, showToast } from "/js/ui.js";

const $ = (selector) => document.querySelector(selector);

// ------------------------------------------------------------------ label (sama dengan backend)
const ORDER_FLOW = ["pending", "confirmed", "preparing", "ready", "completed"];
const STATUS_LABEL = {
  pending: "Menunggu Konfirmasi",
  confirmed: "Dikonfirmasi",
  preparing: "Sedang Disiapkan",
  ready: "Siap Diambil/Diantar",
  completed: "Selesai",
  cancelled: "Dibatalkan",
};
const STATUS_TONE = { pending: "warn", confirmed: "info", preparing: "info", ready: "info", completed: "ok", cancelled: "bad" };
// Status pembayaran DIPISAH dari status pesanan. Untuk QRIS, status ini hanya diubah oleh sistem (webhook/cek gateway).
const PAYMENT_LABEL = {
  unpaid: "Belum Dibayar",
  pending: "Menunggu Pembayaran",
  paid: "Lunas (Terverifikasi)",
  failed: "Pembayaran Gagal",
  expired: "Pembayaran Kedaluwarsa",
  cancelled: "Pembayaran Dibatalkan",
  refunded: "Dikembalikan",
};
const PAYMENT_TONE = { unpaid: "warn", pending: "warn", paid: "ok", failed: "bad", expired: "bad", cancelled: "bad", refunded: "bad" };
const METHOD_LABEL = { cod: "Bayar di Tempat", bank_transfer: "Transfer Manual", qris: "QRIS" };
const FULFILLMENT_LABEL = { pickup: "Ambil Sendiri", delivery: "Diantar" };

/**
 * Perubahan status pembayaran yang boleh dilakukan ADMIN secara manual (server menegakkan aturan yang sama).
 *  - Tunai/transfer: admin memverifikasi uangnya sendiri.
 *  - QRIS: tidak boleh ditandai lunas manual; hanya "Dikembalikan" setelah refund dilakukan di dashboard gateway.
 */
function manualPaymentOptions(order) {
  if (order.payment_method === "qris") return order.payment_status === "paid" ? ["refunded"] : [];
  const next = { unpaid: ["paid"], paid: ["refunded", "unpaid"] }[order.payment_status] ?? [];
  return next.filter((value) => !(value === "paid" && order.order_status === "cancelled"));
}

const shortRef = (reference) => (reference && reference.length > 12 ? `${reference.slice(0, 8)}…` : reference);

// ------------------------------------------------------------------ keadaan aplikasi
const state = {
  user: null,
  csrf: null,
  categories: [],
  tab: "summary",
  orders: { status: "", payment_status: "", q: "", from: "", to: "", page: 1 },
  products: { q: "", category: "", status: "", include_deleted: false },
  messages: { unread: false, page: 1 },
};
let tabToken = 0; // mencegah hasil permintaan lama menimpa tab yang sudah berganti

// ------------------------------------------------------------------ pemanggil API
class ApiFail extends Error {
  constructor({ status = 0, code = "UNKNOWN", message, details }) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function api(path, { method = "GET", json, formData, quiet401 = false } = {}) {
  const headers = { Accept: "application/json" };
  if (method !== "GET") headers["X-CSRF-Token"] = state.csrf ?? "";
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (formData) {
    body = formData; // browser mengisi Content-Type + boundary sendiri
  }

  let response;
  try {
    response = await fetch(`/api/admin${path}`, { method, headers, body, credentials: "same-origin" });
  } catch {
    throw new ApiFail({ code: "NETWORK", message: "Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi." });
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !quiet401) showLogin("Sesi Anda berakhir. Silakan masuk kembali.");
    throw new ApiFail({
      status: response.status,
      code: data?.error?.code ?? "HTTP_ERROR",
      message: data?.error?.message ?? "Terjadi kesalahan pada server.",
      details: data?.error?.details,
    });
  }
  return data;
}

// ------------------------------------------------------------------ fungsi bantu tampilan
const fmtDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";

const pill = (text, tone = "") => h("span", { class: `pill ${tone}`.trim(), text });
const money = (value) => formatRupiah(Number(value) || 0);

/** Pasangan <dt>/<dd> untuk daftar detail. */
const dtRow = (label, value) => [h("dt", { text: label }), h("dd", {}, value)];

/** Kotak peringatan/info dengan tombol aksi opsional. tone: ok | warn | bad | info */
function callout(tone, text, actionLabel, onAction) {
  return h(
    "div",
    { class: `callout ${tone}`, role: tone === "bad" ? "alert" : "note" },
    h("p", { text }),
    actionLabel ? h("button", { type: "button", class: "btn-secondary btn-small", onclick: onAction, text: actionLabel }) : null,
  );
}

function loading(text = "Memuat…") {
  return h("p", { class: "loading", role: "status", text });
}

function errorState(error, retry) {
  return h(
    "div",
    { class: "error-state", role: "alert" },
    h("p", { text: error.message ?? "Gagal memuat data." }),
    retry ? h("button", { type: "button", class: "btn-secondary", onclick: retry, text: "Coba lagi" }) : null,
  );
}

function clearFieldErrors(form) {
  for (const el of form.querySelectorAll(".field-error")) el.textContent = "";
  for (const el of form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
  for (const el of form.querySelectorAll(".has-error")) el.classList.remove("has-error");
}

/** Menampilkan pesan error per field. Mengembalikan pesan yang tidak punya tempat (untuk alert umum). */
function showFieldErrors(form, fields = {}, idFor) {
  const leftovers = [];
  for (const [key, message] of Object.entries(fields)) {
    const errorEl = idFor(key) ? form.querySelector(`#${idFor(key)}-error`) : null;
    if (!errorEl) {
      leftovers.push(message);
      continue;
    }
    errorEl.textContent = message;
    errorEl.closest(".field")?.classList.add("has-error");
    form.querySelector(`#${idFor(key)}`)?.setAttribute("aria-invalid", "true");
  }
  return leftovers;
}

function setAlert(box, message, list = []) {
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.replaceChildren(h("p", { text: message }), list.length > 0 ? h("ul", {}, list.map((text) => h("li", { text }))) : null);
  box.hidden = false;
}

// ------------------------------------------------------------------ login / logout
function showLogin(message = "") {
  state.user = null;
  state.csrf = null;
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
  document.title = "Masuk — Dashboard Admin Royal Bites";
  setAlert($("#login-alert"), message);
  $("#login-password").value = "";
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  $("#login-username").focus();
}

function showApp() {
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  document.title = "Dashboard Admin — Royal Bites";
  $("#whoami").textContent = `${state.user.username} (${state.user.role === "owner" ? "pemilik" : "staf"})`;
  for (const el of document.querySelectorAll("[data-owner-only]")) el.hidden = state.user.role !== "owner";
}

async function handleLogin(event) {
  event.preventDefault();
  const button = $("#login-submit");
  const username = $("#login-username").value.trim();
  const password = $("#login-password").value;
  if (!username || !password) {
    setAlert($("#login-alert"), "Username dan password wajib diisi.");
    return;
  }
  button.disabled = true;
  button.textContent = "Memeriksa…";
  try {
    const data = await api("/login", { method: "POST", json: { username, password }, quiet401: true });
    state.user = data.user;
    state.csrf = data.csrf_token;
    $("#login-password").value = "";
    await startApp();
  } catch (error) {
    setAlert($("#login-alert"), error.status === 429 ? error.message : error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Masuk";
  }
}

async function handleLogout() {
  try {
    await api("/logout", { method: "POST" });
  } catch {
    // Jika server tidak terjangkau, tetap keluarkan dari tampilan.
  }
  showLogin("Anda sudah keluar.");
}

// ------------------------------------------------------------------ tab
const TABS = {
  summary: renderSummary,
  orders: renderOrders,
  products: renderProducts,
  messages: renderMessages,
  settings: renderSettings,
};

async function showTab(name, { focus = false } = {}) {
  if (!TABS[name] || (name === "settings" && state.user.role !== "owner")) name = "summary";
  state.tab = name;
  tabToken += 1;
  for (const tab of document.querySelectorAll(".tab")) {
    if (tab.dataset.tab === name) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  const main = $("#admin-main");
  main.replaceChildren(loading());
  await TABS[name](main, tabToken);
  if (focus) main.focus();
}

/** Lencana jumlah pesanan baru & pesan belum dibaca di tab. */
async function refreshBadges() {
  try {
    const [summary, messages] = await Promise.all([api("/summary"), api("/messages?unread=1")]);
    const pending = Number(summary.queue.pending);
    const unread = Number(messages.unread);
    const ordersBadge = $("#tab-badge-orders");
    ordersBadge.textContent = String(pending);
    ordersBadge.hidden = pending === 0;
    const messagesBadge = $("#tab-badge-messages");
    messagesBadge.textContent = String(unread);
    messagesBadge.hidden = unread === 0;
  } catch {
    // lencana hanyalah pelengkap
  }
}

// ================================================================== RINGKASAN
async function renderSummary(root, token, range = {}) {
  let data;
  try {
    const query = range.from && range.to ? `?from=${range.from}&to=${range.to}` : "";
    data = await api(`/summary${query}`);
  } catch (error) {
    if (token === tabToken) root.replaceChildren(errorState(error, () => renderSummary(root, token, range)));
    return;
  }
  if (token !== tabToken) return;
  const { totals, queue, top_products: top, daily, attention, payment_breakdown: breakdown } = data;

  const stat = (label, value, note) =>
    h("div", { class: "stat" }, h("div", { class: "label", text: label }), h("div", { class: "value", text: value }), note ? h("div", { class: "note", text: note }) : null);

  const rangeForm = h(
    "form",
    { class: "filters", onsubmit: (event) => {
      event.preventDefault();
      const from = event.target.elements.from.value;
      const to = event.target.elements.to.value;
      if (!from || !to) return showToast("Isi tanggal awal dan akhir.", { error: true });
      if (from > to) return showToast("Tanggal awal tidak boleh setelah tanggal akhir.", { error: true });
      root.replaceChildren(loading());
      renderSummary(root, token, { from, to });
    } },
    h("div", { class: "field" }, h("label", { for: "sum-from", text: "Dari tanggal" }), h("input", { id: "sum-from", name: "from", type: "date", value: data.range.from, required: true })),
    h("div", { class: "field" }, h("label", { for: "sum-to", text: "Sampai tanggal" }), h("input", { id: "sum-to", name: "to", type: "date", value: data.range.to, required: true })),
    h("button", { type: "submit", class: "btn-secondary btn-small", text: "Terapkan" }),
  );

  const goOrders = (filters) => {
    state.orders = { status: "", payment_status: "", q: "", from: "", to: "", page: 1, ...filters };
    showTab("orders", { focus: true });
  };

  const queueCard = (key, label) =>
    h(
      "div",
      { class: "stat queue" },
      h(
        "button",
        { type: "button", onclick: () => goOrders({ status: key }) },
        h("div", { class: "label", text: label }),
        h("div", { class: "value", text: String(queue[key]) }),
        h("div", { class: "note", text: "Lihat daftar" }),
      ),
    );

  const maxDaily = Math.max(1, ...daily.map((row) => Number(row.order_value)));
  const dailyRows = daily.length
    ? daily.map((row) =>
        h(
          "div",
          { class: "bar-row" },
          h("span", { text: row.day }),
          h("progress", { max: maxDaily, value: Number(row.order_value), "aria-label": `Nilai pesanan ${row.day}` }),
          h("span", { text: `${money(row.order_value)} · ${row.orders} pesanan · lunas ${money(row.paid_value)}` }),
        ),
      )
    : [h("p", { class: "empty-state", text: "Belum ada pesanan pada rentang ini." })];

  // ---- Hal yang perlu perhatian (tidak tergantung rentang tanggal)
  const alerts = [];
  if (Number(attention.paid_but_cancelled) > 0) {
    alerts.push(
      callout("bad", `${attention.paid_but_cancelled} pesanan sudah DIBAYAR tetapi dibatalkan. Uang tidak otomatis kembali: lakukan refund (QRIS: di dashboard gateway) lalu catat “Dikembalikan”.`, "Lihat pesanan", () => goOrders({ status: "cancelled", payment_status: "paid" })),
    );
  }
  if (Number(attention.payments_need_review) > 0) {
    alerts.push(
      callout("warn", `${attention.payments_need_review} pembayaran QRIS perlu ditinjau (nominal tidak cocok, dibayar terlambat, atau pembayaran ganda). Buka detail pesanan untuk melihat catatannya.`, "Lihat pesanan", () => goOrders({})),
    );
  }
  if (Number(attention.awaiting_qris_payment) > 0) {
    alerts.push(
      callout("info", `${attention.awaiting_qris_payment} pesanan QRIS sedang menunggu pembayaran pelanggan. Pesanan ini belum dihitung sebagai pendapatan.`, "Lihat pesanan", () => goOrders({ status: "pending", payment_status: "pending" })),
    );
  }

  const lowStock = attention.low_stock;
  const lowStockTable = lowStock.length
    ? h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "data", id: "low-stock-table" },
          h("thead", {}, h("tr", {}, h("th", { text: "Menu" }), h("th", { class: "num", text: "Stok" }), h("th", { text: "Status" }), h("th", { text: "" }))),
          h(
            "tbody",
            {},
            lowStock.map((item) =>
              h(
                "tr",
                {},
                h("td", {}, h("strong", { text: item.name })),
                h("td", { class: "num", text: String(item.stock) }),
                h("td", {}, item.stock <= 0 ? pill("Habis", "bad") : pill("Menipis", "warn"), item.is_available ? null : pill("Disembunyikan", "warn")),
                h(
                  "td",
                  {},
                  h("button", {
                    type: "button",
                    class: "btn-secondary btn-small",
                    "aria-label": `Atur stok ${item.name}`,
                    onclick: () => {
                      state.products = { q: item.name, category: "", status: "", include_deleted: false };
                      showTab("products", { focus: true });
                    },
                    text: "Atur stok",
                  }),
                ),
              ),
            ),
          ),
        ),
      )
    : h("p", { class: "empty-state", text: `Tidak ada menu dengan stok menipis (batas: stok ≤ ${attention.low_stock_threshold}).` });

  const breakdownTable = breakdown.length
    ? h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "data" },
          h("thead", {}, h("tr", {}, h("th", { text: "Metode pembayaran" }), h("th", { class: "num", text: "Pesanan lunas" }), h("th", { class: "num", text: "Nilai" }))),
          h("tbody", {}, breakdown.map((row) => h("tr", {}, h("td", { text: METHOD_LABEL[row.payment_method] ?? row.payment_method }), h("td", { class: "num", text: String(row.orders) }), h("td", { class: "num", text: money(row.value) })))),
        ),
      )
    : h("p", { class: "empty-state", text: "Belum ada pembayaran lunas pada rentang ini." });

  root.replaceChildren(
    h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Ringkasan" }), h("p", { class: "page-note", text: "Angka dipisahkan agar tidak menyesatkan: nilai pesanan belum tentu sudah dibayar. Pendapatan hanya dihitung dari pembayaran yang benar-benar lunas." }))),
    ...alerts,
    rangeForm,
    h(
      "div",
      { class: "cards" },
      stat("Total pesanan", String(totals.total_orders), `${totals.active_orders} aktif · ${totals.completed_orders} selesai · ${totals.cancelled_orders} dibatalkan`),
      stat("Nilai pesanan (belum tentu dibayar)", money(totals.order_value), data.notes.order_value),
      stat("Lunas terverifikasi", money(totals.verified_paid), `${totals.paid_orders} pesanan lunas (bukan pesanan batal)`),
      stat("Belum dibayar", money(totals.unpaid_value), "Pesanan aktif yang belum lunas (tunai/transfer belum ditandai, QRIS menunggu/gagal)."),
      stat("Dibatalkan", money(totals.cancelled_value), "Bukan pendapatan."),
      stat("Dikembalikan (refund)", money(totals.refunded_value), "Pembayaran yang sudah dikembalikan."),
    ),
    h("p", { class: "page-note", id: "verified-note", text: data.notes.verified_paid }),
    h("h2", { class: "section-title", text: "Antrian kerja saat ini" }),
    h("div", { class: "cards" }, queueCard("pending", "Menunggu konfirmasi"), queueCard("confirmed", "Dikonfirmasi"), queueCard("preparing", "Sedang disiapkan"), queueCard("ready", "Siap diambil/diantar")),
    h("h2", { class: "section-title", text: "Stok menipis" }),
    h("p", { class: "page-note", text: `Menu dengan stok yang dihitung dan sisa ≤ ${attention.low_stock_threshold}. Pemilik dapat mengubah batas ini di Pengaturan.` }),
    lowStockTable,
    h(
      "div",
      { class: "split" },
      h(
        "div",
        {},
        h("h2", { class: "section-title", text: "Menu terlaris" }),
        h("p", { class: "page-note", text: data.notes.top_products }),
        top.length
          ? h(
              "div",
              { class: "table-wrap" },
              h(
                "table",
                { class: "data" },
                h("thead", {}, h("tr", {}, h("th", { text: "Menu" }), h("th", { class: "num", text: "Terjual" }), h("th", { class: "num", text: "Nilai" }), h("th", { class: "num", text: "Lunas" }))),
                h("tbody", {}, top.map((row) => h("tr", {}, h("td", { text: row.name }), h("td", { class: "num", text: String(row.quantity_sold) }), h("td", { class: "num", text: money(row.sales_value) }), h("td", { class: "num", text: money(row.paid_value) })))),
              ),
            )
          : h("p", { class: "empty-state", text: "Belum ada data." }),
      ),
      h("div", {}, h("h2", { class: "section-title", text: "Nilai pesanan per hari" }), ...dailyRows),
    ),
    h("h2", { class: "section-title", text: "Pendapatan lunas per metode pembayaran" }),
    breakdownTable,
  );
}

// ================================================================== PESANAN
function orderFiltersForm(onChange) {
  const f = state.orders;
  const option = (value, label, selected) => h("option", { value, selected: selected ? true : null, text: label });
  return h(
    "form",
    { class: "filters", onsubmit: (event) => {
      event.preventDefault();
      const el = event.target.elements;
      state.orders = { status: el.status.value, payment_status: el.payment_status.value, q: el.q.value.trim(), from: el.from.value, to: el.to.value, page: 1 };
      onChange();
    } },
    h("div", { class: "field" }, h("label", { for: "of-q", text: "Cari (no. pesanan / nama / telepon)" }), h("input", { id: "of-q", name: "q", type: "search", value: f.q, maxlength: 100 })),
    h("div", { class: "field" }, h("label", { for: "of-status", text: "Status pesanan" }), h("select", { id: "of-status", name: "status" }, option("", "Semua", !f.status), ...Object.entries(STATUS_LABEL).map(([v, l]) => option(v, l, f.status === v)))),
    h("div", { class: "field" }, h("label", { for: "of-payment", text: "Pembayaran" }), h("select", { id: "of-payment", name: "payment_status" }, option("", "Semua", !f.payment_status), ...Object.entries(PAYMENT_LABEL).map(([v, l]) => option(v, l, f.payment_status === v)))),
    h("div", { class: "field" }, h("label", { for: "of-from", text: "Dari tanggal" }), h("input", { id: "of-from", name: "from", type: "date", value: f.from })),
    h("div", { class: "field" }, h("label", { for: "of-to", text: "Sampai tanggal" }), h("input", { id: "of-to", name: "to", type: "date", value: f.to })),
    h("button", { type: "submit", class: "btn-secondary btn-small", text: "Terapkan" }),
    h("button", { type: "button", class: "link-btn", text: "Reset", onclick: () => {
      state.orders = { status: "", payment_status: "", q: "", from: "", to: "", page: 1 };
      onChange(true);
    } }),
  );
}

async function renderOrders(root, token, { rebuildFilters = true } = {}) {
  const f = state.orders;
  const params = new URLSearchParams({ page: String(f.page), page_size: "20" });
  for (const key of ["status", "payment_status", "q", "from", "to"]) if (f[key]) params.set(key, f[key]);

  const rerender = (rebuild = true) => {
    root.replaceChildren(loading());
    renderOrders(root, token, { rebuildFilters: rebuild });
  };

  let data;
  try {
    data = await api(`/orders?${params}`);
  } catch (error) {
    if (token === tabToken) root.replaceChildren(errorState(error, () => rerender()));
    return;
  }
  if (token !== tabToken) return;

  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size));
  const table = data.items.length
    ? h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "data" },
          h("thead", {}, h("tr", {}, ["No. Pesanan", "Waktu", "Pelanggan", "Item", "Total", "Pembayaran", "Status", ""].map((t, i) => h("th", { class: i === 3 || i === 4 ? "num" : "", text: t })))),
          h(
            "tbody",
            {},
            data.items.map((order) =>
              h(
                "tr",
                { dataset: { orderId: order.id } },
                h("td", {}, h("strong", { text: order.order_number })),
                h(
                  "td",
                  {},
                  fmtDateTime(order.created_at),
                  order.payment_method === "qris" && order.payment_status === "pending" && order.payment_expires_at
                    ? h("span", { class: "cell-sub", text: `Bayar sebelum ${fmtDateTime(order.payment_expires_at)}` })
                    : null,
                ),
                h("td", {}, order.customer_name, h("span", { class: "cell-sub", text: `+${order.customer_phone} · ${FULFILLMENT_LABEL[order.fulfillment_method] ?? order.fulfillment_method}` })),
                h("td", { class: "num", text: String(order.item_count) }),
                h("td", { class: "num", text: money(order.total) }),
                h(
                  "td",
                  {},
                  pill(PAYMENT_LABEL[order.payment_status] ?? order.payment_status, PAYMENT_TONE[order.payment_status]),
                  order.needs_review ? pill("Perlu ditinjau", "warn") : null,
                  h("span", { class: "cell-sub", text: METHOD_LABEL[order.payment_method] ?? order.payment_method }),
                  order.gateway_reference ? h("span", { class: "cell-sub mono", title: order.gateway_reference, text: `Ref gateway: ${shortRef(order.gateway_reference)}` }) : null,
                  order.paid_at ? h("span", { class: "cell-sub", text: `Dibayar ${fmtDateTime(order.paid_at)}` }) : null,
                ),
                h("td", {}, pill(STATUS_LABEL[order.order_status] ?? order.order_status, STATUS_TONE[order.order_status])),
                h("td", {}, h("div", { class: "row-actions" }, h("button", { type: "button", class: "btn-secondary btn-small", "aria-label": `Lihat detail pesanan ${order.order_number}`, onclick: () => openOrder(order.id), text: "Detail" }))),
              ),
            ),
          ),
        ),
      )
    : h("p", { class: "empty-state", text: "Tidak ada pesanan yang cocok." });

  const pager = h(
    "div",
    { class: "pager" },
    h("span", { text: `${data.total} pesanan · halaman ${data.page} dari ${totalPages}` }),
    h(
      "div",
      { class: "buttons" },
      h("button", { type: "button", class: "btn-secondary btn-small", disabled: data.page <= 1 ? true : null, onclick: () => { state.orders.page -= 1; rerender(false); }, text: "Sebelumnya" }),
      h("button", { type: "button", class: "btn-secondary btn-small", disabled: data.page >= totalPages ? true : null, onclick: () => { state.orders.page += 1; rerender(false); }, text: "Berikutnya" }),
    ),
  );

  root.replaceChildren(
    h(
      "div",
      { class: "page-head" },
      h("div", {}, h("h1", { text: "Pesanan" }), h("p", { class: "page-note", text: "Pesanan masuk dari situs. Ubah status sesuai perkembangan dan tandai lunas hanya setelah uang diterima." })),
      h("button", { type: "button", class: "btn-secondary btn-small", onclick: () => rerender(false), text: "Muat ulang" }),
    ),
    orderFiltersForm(rerender),
    table,
    pager,
  );
}

// ------------------------------------------------------------------ detail pesanan
let openOrderId = null;

async function openOrder(id) {
  openOrderId = id;
  const box = $("#order-detail");
  box.replaceChildren(loading());
  openDialog($("#order-dialog"));
  try {
    const { order } = await api(`/orders/${id}`);
    renderOrderDetail(order);
  } catch (error) {
    box.replaceChildren(errorState(error, () => openOrder(id)));
  }
}

function allowedNextStatuses(current) {
  if (current === "completed" || current === "cancelled") return [];
  const index = ORDER_FLOW.indexOf(current);
  return [...ORDER_FLOW.slice(index + 1), "cancelled"];
}

function renderOrderDetail(order) {
  const box = $("#order-detail");
  const dt = dtRow;
  const phoneLink = h("a", { href: `https://wa.me/${order.customer_phone}`, target: "_blank", rel: "noopener noreferrer", text: `+${order.customer_phone}` });

  // Pesanan QRIS baru boleh diproses setelah LUNAS (server menegakkan ini juga). Sebelum itu hanya bisa dibatalkan.
  const qrisUnpaid = order.payment_method === "qris" && order.payment_status !== "paid";
  const nextStatuses = allowedNextStatuses(order.order_status).filter((value) => !qrisUnpaid || value === "cancelled");
  const statusForm = nextStatuses.length
    ? h(
        "form",
        { class: "inline-form", id: "status-form", onsubmit: (event) => { event.preventDefault(); submitStatus(order, event.target); } },
        h("div", { class: "field" }, h("label", { for: "st-status", text: "Ubah status menjadi" }), h("select", { id: "st-status", name: "status" }, nextStatuses.map((value) => h("option", { value, text: STATUS_LABEL[value] })))),
        h("div", { class: "field" }, h("label", { for: "st-note", text: "Catatan / alasan (opsional)" }), h("input", { id: "st-note", name: "note", type: "text", maxlength: 255 })),
        h("button", { type: "submit", class: "checkout-btn", text: "Simpan status" }),
      )
    : h("p", { class: "page-note", text: `Pesanan berstatus “${STATUS_LABEL[order.order_status]}” sudah final dan tidak bisa diubah lagi.` });
  const statusHint = qrisUnpaid && nextStatuses.length
    ? h("p", { class: "page-note", text: "Pesanan QRIS baru bisa dikonfirmasi/diproses setelah pembayaran berstatus Lunas. Sebelum itu hanya bisa dibatalkan." })
    : null;

  box.replaceChildren(
    h("div", { class: "row-actions", "aria-label": "Status" }, pill(STATUS_LABEL[order.order_status], STATUS_TONE[order.order_status]), pill(PAYMENT_LABEL[order.payment_status], PAYMENT_TONE[order.payment_status])),
    h(
      "dl",
      { class: "detail-grid" },
      ...dt("Nomor pesanan", h("strong", { text: order.order_number })),
      ...dt("Waktu pesan", fmtDateTime(order.created_at)),
      ...dt("Pelanggan", order.customer_name),
      ...dt("WhatsApp", phoneLink),
      ...dt("Pengambilan", FULFILLMENT_LABEL[order.fulfillment_method] ?? order.fulfillment_method),
      ...dt("Alamat pengantaran", order.delivery_address || "-"),
      ...dt("Catatan pelanggan", order.customer_notes || "-"),
      ...dt("Metode pembayaran", METHOD_LABEL[order.payment_method] ?? order.payment_method),
      ...(order.cancel_reason ? dt("Alasan pembatalan", order.cancel_reason) : []),
    ),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "data" },
        h("thead", {}, h("tr", {}, h("th", { text: "Menu" }), h("th", { class: "num", text: "Harga" }), h("th", { class: "num", text: "Jumlah" }), h("th", { class: "num", text: "Subtotal" }))),
        h(
          "tbody",
          {},
          order.items.map((item) => h("tr", {}, h("td", { text: item.name }), h("td", { class: "num", text: money(item.unit_price) }), h("td", { class: "num", text: String(item.quantity) }), h("td", { class: "num", text: money(item.line_total) }))),
          h("tr", {}, h("td", { colspan: 3, text: "Subtotal" }), h("td", { class: "num", text: money(order.subtotal) })),
          h("tr", {}, h("td", { colspan: 3, text: "Ongkos kirim" }), h("td", { class: "num", text: money(order.delivery_fee) })),
          h("tr", {}, h("td", { colspan: 3 }, h("strong", { text: "Total" })), h("td", { class: "num" }, h("strong", { text: money(order.total) }))),
        ),
      ),
    ),
    h("section", { class: "panel" }, h("h3", { text: "Status pesanan" }), statusHint, statusForm),
    paymentPanel(order),
    h(
      "section",
      { class: "panel" },
      h("h3", { text: "Riwayat perubahan" }),
      order.events.length
        ? h(
            "ul",
            { class: "timeline" },
            order.events.map((event) => {
              if (event.event_type === "created") {
                return h("li", {}, h("time", { text: fmtDateTime(event.created_at) }), "Pesanan dibuat oleh pelanggan (menunggu konfirmasi).");
              }
              const labels = event.event_type === "status" ? STATUS_LABEL : PAYMENT_LABEL;
              const what = event.event_type === "status" ? "Status" : "Pembayaran";
              return h(
                "li",
                {},
                h("time", { text: fmtDateTime(event.created_at) }),
                `${what}: ${event.from_value ? labels[event.from_value] ?? event.from_value : "—"} → ${labels[event.to_value] ?? event.to_value}`,
                event.admin_username ? ` oleh ${event.admin_username}` : "",
                event.note ? ` — “${event.note}”` : "",
              );
            }),
          )
        : h("p", { class: "page-note", text: "Belum ada perubahan." }),
    ),
  );
}

// ------------------------------------------------------------------ panel pembayaran di detail pesanan
function paymentPanel(order) {
  const isQris = order.payment_method === "qris";
  const options = manualPaymentOptions(order);
  const dt = dtRow;

  const summary = h(
    "dl",
    { class: "detail-grid" },
    ...dt("Metode", METHOD_LABEL[order.payment_method] ?? order.payment_method),
    ...dt("Status pembayaran", pill(PAYMENT_LABEL[order.payment_status] ?? order.payment_status, PAYMENT_TONE[order.payment_status])),
    ...dt("Pesanan dibuat", fmtDateTime(order.created_at)),
    ...dt("Dibayar pada", fmtDateTime(order.paid_at)),
    ...(isQris ? dt("Batas waktu bayar", fmtDateTime(order.payment_expires_at)) : []),
  );

  const actions = options.length
    ? h(
        "div",
        { class: "row-actions" },
        options.map((next) =>
          h("button", {
            type: "button",
            class: next === "paid" ? "checkout-btn" : "btn-secondary",
            onclick: () => submitPayment(order, next),
            text: next === "paid" ? "Tandai Lunas (uang sudah diterima)" : next === "refunded" ? "Catat Sudah Dikembalikan" : "Kembalikan ke Belum Dibayar",
          }),
        ),
      )
    : h("p", { class: "page-note", text: "Tidak ada perubahan pembayaran manual yang tersedia." });

  const guidance = isQris
    ? h("p", { class: "page-note", text: "Status pembayaran QRIS hanya diubah otomatis oleh sistem berdasarkan notifikasi/konfirmasi dari gateway. Tidak bisa ditandai lunas manual. Jika perlu refund, lakukan di dashboard gateway (Midtrans), lalu catat “Dikembalikan” di sini." })
    : h("p", { class: "page-note", text: "“Lunas” hanya boleh dipilih setelah Anda memastikan uang benar-benar diterima (mis. cek mutasi rekening). Membuka WhatsApp bukan bukti bayar." });

  return h("section", { class: "panel", id: "payment-panel" }, h("h3", { text: "Pembayaran" }), summary, guidance, isQris ? gatewayBlock(order) : null, actions);
}

/** Riwayat percobaan pembayaran ke gateway: referensi transaksi, status, waktu, catatan tinjau, dan notifikasi yang diterima. */
function gatewayBlock(order) {
  const payments = order.payments ?? [];
  if (payments.length === 0) {
    return h("p", { class: "page-note", text: "Belum ada transaksi di gateway untuk pesanan ini (pembuatan kode QRIS belum berhasil)." });
  }
  const hasPending = payments.some((payment) => payment.status === "pending");
  const reviews = payments.filter((payment) => payment.review_note);

  const rows = payments.map((payment, index) =>
    h(
      "tr",
      { dataset: { paymentId: payment.id } },
      h("td", { text: String(index + 1) }),
      h(
        "td",
        {},
        h("span", { class: "mono", text: payment.provider_transaction_id ?? "(belum ada)" }),
        h("span", { class: "cell-sub mono", text: `Order ID gateway: ${payment.provider_order_id}` }),
        payment.provider === "mock" ? pill("MOCK", "warn") : null,
      ),
      h(
        "td",
        {},
        pill(PAYMENT_LABEL[payment.status] ?? payment.status, PAYMENT_TONE[payment.status]),
        payment.provider_status ? h("span", { class: "cell-sub", text: `Status gateway: ${payment.provider_status}` }) : null,
        payment.failure_reason ? h("span", { class: "cell-sub", text: `Alasan: ${payment.failure_reason}` }) : null,
      ),
      h("td", { class: "num", text: money(payment.amount) }),
      h(
        "td",
        {},
        h("span", { text: `Dibuat ${fmtDateTime(payment.created_at)}` }),
        h("span", { class: "cell-sub", text: `Kedaluwarsa ${fmtDateTime(payment.expires_at)}` }),
        h("span", { class: "cell-sub", text: `Dibayar ${fmtDateTime(payment.paid_at)}` }),
        payment.last_checked_at ? h("span", { class: "cell-sub", text: `Dicek ${fmtDateTime(payment.last_checked_at)}` }) : null,
      ),
    ),
  );

  const notifications = payments.flatMap((payment) => payment.notifications ?? []);
  const notificationList = notifications.length
    ? h(
        "details",
        { class: "notifications" },
        h("summary", { text: `Notifikasi dari gateway (${notifications.length} terakhir)` }),
        h("ul", { class: "timeline" }, notifications.map((item) => h("li", {}, h("time", { text: fmtDateTime(item.received_at) }), `Status “${item.transaction_status}” → hasil: ${item.outcome}`))),
      )
    : null;

  return h(
    "div",
    { class: "gateway-block" },
    ...reviews.map((payment) => callout("warn", `Perlu ditinjau: ${payment.review_note}`)),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "data" },
        h("thead", {}, h("tr", {}, ["#", "Referensi transaksi gateway", "Status", "Nominal", "Waktu"].map((t, i) => h("th", { class: i === 3 ? "num" : "", text: t })))),
        h("tbody", {}, rows),
      ),
    ),
    notificationList,
    hasPending
      ? h(
          "div",
          { class: "row-actions" },
          h("button", {
            type: "button",
            id: "check-gateway",
            class: "btn-secondary",
            onclick: (event) => refreshGatewayStatus(order, event.currentTarget),
            text: "Periksa status ke gateway",
          }),
        )
      : null,
  );
}

async function refreshGatewayStatus(order, button) {
  button.disabled = true;
  try {
    const { check, order: fresh } = await api(`/orders/${order.id}/payment/refresh`, { method: "POST" });
    let message = "Status diperiksa ke gateway.";
    if (!check.checked) {
      message =
        check.reason === "no_pending_payment" ? "Tidak ada pembayaran yang sedang menunggu." : "Penyedia pembayaran ini tidak mendukung pemeriksaan status.";
    } else if (check.found === false) {
      message = "Gateway belum mencatat transaksi ini.";
    }
    showToast(message);
    await afterOrderChange(fresh);
  } catch (error) {
    showToast(error.message, { error: true });
    button.disabled = false;
  }
}

async function afterOrderChange(order) {
  renderOrderDetail(order);
  refreshBadges();
  if (state.tab === "orders") {
    const main = $("#admin-main");
    tabToken += 1;
    renderOrders(main, tabToken);
  }
}

async function submitStatus(order, form) {
  const status = form.elements.status.value;
  const note = form.elements.note.value.trim();
  if (status === "cancelled") {
    let warning = "";
    if (order.payment_status === "paid") {
      warning = " PERHATIAN: pesanan ini sudah DIBAYAR. Uang tidak otomatis kembali; lakukan refund (QRIS: di dashboard gateway) lalu catat “Dikembalikan”.";
    } else if (order.payment_method === "qris" && order.payment_status === "pending") {
      warning = " Transaksi QRIS yang menunggu juga akan ditutup di gateway.";
    }
    const ok = await confirmAction({
      title: "Batalkan pesanan?",
      message: `Pesanan ${order.order_number} akan dibatalkan dan stok produk yang dihitung akan dikembalikan. Pembatalan tidak bisa dibatalkan lagi.${warning}`,
      confirmLabel: "Ya, batalkan pesanan",
    });
    if (!ok) return;
  }
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = await api(`/orders/${order.id}/status`, { method: "PATCH", json: { status, note: note || null } });
    showToast(`Status diubah menjadi “${STATUS_LABEL[status]}”.`);
    await afterOrderChange(data.order);
  } catch (error) {
    showToast(error.message, { error: true });
    button.disabled = false;
  }
}

async function submitPayment(order, next) {
  const messages = {
    paid: "Tandai pesanan ini LUNAS? Lakukan hanya jika uang sudah benar-benar diterima.",
    refunded:
      order.payment_method === "qris"
        ? "Catat pembayaran ini sebagai DIKEMBALIKAN? Lakukan hanya setelah refund benar-benar diproses di dashboard gateway."
        : "Tandai pembayaran sebagai DIKEMBALIKAN?",
    unpaid: "Kembalikan status pembayaran menjadi BELUM DIBAYAR?",
  };
  const ok = await confirmAction({ title: "Ubah status pembayaran", message: messages[next], confirmLabel: "Ya, ubah" });
  if (!ok) return;
  try {
    const data = await api(`/orders/${order.id}/payment`, { method: "PATCH", json: { payment_status: next } });
    showToast(`Pembayaran: ${PAYMENT_LABEL[next]}.`);
    await afterOrderChange(data.order);
  } catch (error) {
    showToast(error.message, { error: true });
  }
}

// ================================================================== PRODUK
async function renderProducts(root, token) {
  const f = state.products;
  const rerender = () => {
    root.replaceChildren(loading());
    renderProducts(root, token);
  };
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.category) params.set("category", f.category);
  if (f.include_deleted) params.set("include_deleted", "1");

  let data;
  let threshold = 5;
  try {
    const [productsData, settingsData] = await Promise.all([api(`/products?${params}`), api("/settings").catch(() => null)]);
    data = productsData;
    threshold = Number(settingsData?.settings?.low_stock_threshold ?? 5);
  } catch (error) {
    if (token === tabToken) root.replaceChildren(errorState(error, rerender));
    return;
  }
  if (token !== tabToken) return;
  const isOwner = state.user.role === "owner";
  const categoryLabel = (value) => state.categories.find((c) => c.value === value)?.label ?? value;

  // Keadaan tiap menu (dipakai untuk pil status DAN filter status).
  const stateOf = (product) => {
    if (product.deleted_at) return "deleted";
    if (!product.is_available) return "hidden";
    if (product.track_stock && product.stock <= 0) return "soldout";
    if (product.track_stock && product.stock <= threshold) return "low";
    return "visible";
  };
  const matchesStatus = (product) => {
    if (!f.status) return true;
    if (f.status === "visible") return ["visible", "low"].includes(stateOf(product));
    return stateOf(product) === f.status;
  };
  const visibleProducts = data.products.filter(matchesStatus);
  const activeCount = data.products.filter((product) => !product.deleted_at).length;
  const shownCount = data.products.filter((product) => !product.deleted_at && product.is_available).length;

  const rows = visibleProducts.map((product) => {
    const deleted = Boolean(product.deleted_at);
    const stockText = product.track_stock ? `${product.stock}` : "Tanpa batas";
    const productState = stateOf(product);
    let statusPill = pill("Tampil", "ok");
    if (productState === "deleted") statusPill = pill("Dihapus", "bad");
    else if (productState === "hidden") statusPill = pill("Disembunyikan", "warn");
    else if (productState === "soldout") statusPill = pill("Stok habis", "bad");
    else if (productState === "low") statusPill = pill("Stok menipis", "warn");

    return h(
      "tr",
      { class: deleted ? "is-deleted" : "", dataset: { productId: product.id } },
      h("td", {}, h("img", { class: "thumb", src: product.image || placeholderFor(product.category), alt: "", width: 48, height: 48, loading: "lazy" })),
      h("td", {}, h("strong", { text: product.name }), h("span", { class: "cell-sub", text: product.description })),
      h("td", { text: categoryLabel(product.category) }),
      h("td", { class: "num", text: money(product.price) }),
      h("td", { class: "num", text: stockText }),
      h("td", {}, statusPill),
      h(
        "td",
        {},
        deleted
          ? null
          : h(
              "div",
              { class: "row-actions" },
              h("button", { type: "button", class: "btn-secondary btn-small", onclick: () => openProductForm(product), "aria-label": `Ubah ${product.name}`, text: "Ubah" }),
              h("button", { type: "button", class: "btn-secondary btn-small", onclick: () => toggleAvailability(product, rerender), "aria-label": `${product.is_available ? "Sembunyikan" : "Tampilkan"} ${product.name}`, text: product.is_available ? "Sembunyikan" : "Tampilkan" }),
              isOwner ? h("button", { type: "button", class: "danger-btn btn-small", onclick: () => deleteProduct(product, rerender), "aria-label": `Hapus ${product.name}`, text: "Hapus" }) : null,
            ),
      ),
    );
  });

  root.replaceChildren(
    h(
      "div",
      { class: "page-head" },
      h("div", {}, h("h1", { text: "Produk" }), h("p", { class: "page-note", text: "Perubahan langsung tampil di situs pelanggan. Produk yang dihapus tetap tersimpan agar riwayat pesanan tidak rusak." })),
      h("button", { type: "button", class: "checkout-btn", onclick: () => openProductForm(null), text: "+ Tambah produk" }),
    ),
    h(
      "form",
      { class: "filters", onsubmit: (event) => {
        event.preventDefault();
        const el = event.target.elements;
        state.products = { q: el.q.value.trim(), category: el.category.value, status: el.status.value, include_deleted: el.include_deleted.checked };
        rerender();
      } },
      h("div", { class: "field" }, h("label", { for: "pf-q", text: "Cari nama" }), h("input", { id: "pf-q", name: "q", type: "search", value: f.q, maxlength: 100 })),
      h("div", { class: "field" }, h("label", { for: "pf-cat", text: "Kategori" }), h("select", { id: "pf-cat", name: "category" }, h("option", { value: "", text: "Semua" }), ...state.categories.map((c) => h("option", { value: c.value, selected: f.category === c.value ? true : null, text: c.label })))),
      h(
        "div",
        { class: "field" },
        h("label", { for: "pf-status", text: "Status" }),
        h(
          "select",
          { id: "pf-status", name: "status" },
          [["", "Semua"], ["visible", "Tampil"], ["hidden", "Disembunyikan"], ["low", "Stok menipis"], ["soldout", "Stok habis"]].map(([value, label]) =>
            h("option", { value, selected: f.status === value ? true : null, text: label }),
          ),
        ),
      ),
      h("label", { class: "check" }, h("input", { name: "include_deleted", type: "checkbox", checked: f.include_deleted ? true : null }), "Tampilkan yang dihapus"),
      h("button", { type: "submit", class: "btn-secondary btn-small", text: "Terapkan" }),
    ),
    h("p", { class: "page-note", id: "product-count", text: `${visibleProducts.length} menu ditampilkan di daftar · ${activeCount} menu aktif, ${shownCount} tampil di situs.` }),
    rows.length
      ? h("div", { class: "table-wrap" }, h("table", { class: "data" }, h("thead", {}, h("tr", {}, [["Foto", ""], ["Nama", ""], ["Kategori", ""], ["Harga", "num"], ["Stok", "num"], ["Status", ""], ["", ""]].map(([t, c]) => h("th", { class: c, text: t })))), h("tbody", {}, rows)))
      : h("p", { class: "empty-state", text: f.q || f.category || f.status ? "Tidak ada menu yang cocok dengan filter." : "Belum ada produk. Klik “Tambah produk” untuk mulai." }),
  );
}

async function toggleAvailability(product, done) {
  try {
    await api(`/products/${product.id}`, { method: "PATCH", json: { is_available: !product.is_available } });
    showToast(product.is_available ? `${product.name} disembunyikan dari menu.` : `${product.name} ditampilkan di menu.`);
    done();
  } catch (error) {
    showToast(error.message, { error: true });
  }
}

async function deleteProduct(product, done) {
  const ok = await confirmAction({
    title: "Hapus produk?",
    message: `“${product.name}” akan dihapus dari menu. Riwayat pesanan yang sudah ada tidak berubah.`,
    confirmLabel: "Ya, hapus",
  });
  if (!ok) return;
  try {
    await api(`/products/${product.id}`, { method: "DELETE" });
    showToast(`${product.name} dihapus.`);
    done();
  } catch (error) {
    showToast(error.message, { error: true });
  }
}

// ------------------------------------------------------------------ form produk
const productForm = { editing: null, imagePath: null };
const PF_FIELDS = { name: "pf-name", description: "pf-description", price: "pf-price", category: "pf-category", stock: "pf-stock", image: "pf-image" };

function syncStockField() {
  $("#pf-stock-field").hidden = !$("#pf-track").checked;
}

function setPreview(path) {
  const preview = $("#pf-preview");
  preview.hidden = !path;
  if (path) preview.src = path;
  $("#pf-remove-image").hidden = !path;
}

function openProductForm(product) {
  productForm.editing = product;
  productForm.imagePath = product?.image ?? null;
  const form = $("#product-form");
  clearFieldErrors(form);
  setAlert($("#pf-alert"), "");
  $("#pf-title").textContent = product ? `Ubah Produk` : "Tambah Produk";
  $("#pf-name").value = product?.name ?? "";
  $("#pf-description").value = product?.description ?? "";
  $("#pf-price").value = product ? String(product.price) : "";
  $("#pf-category").replaceChildren(...state.categories.map((c) => h("option", { value: c.value, text: c.label })));
  $("#pf-category").value = product?.category ?? state.categories[0]?.value ?? "";
  $("#pf-available").checked = product ? product.is_available : true;
  $("#pf-track").checked = product ? product.track_stock : false;
  $("#pf-stock").value = product ? String(product.stock) : "0";
  $("#pf-image").value = "";
  setPreview(productForm.imagePath);
  syncStockField();
  openDialog($("#product-dialog"));
  $("#pf-name").focus();
}

async function submitProductForm(event) {
  event.preventDefault();
  const form = event.target;
  clearFieldErrors(form);
  setAlert($("#pf-alert"), "");

  const price = Number($("#pf-price").value);
  const track = $("#pf-track").checked;
  const stock = Number($("#pf-stock").value || 0);
  const errors = {};
  if ($("#pf-name").value.trim().length < 2) errors.name = "Nama minimal 2 karakter.";
  if (!Number.isInteger(price) || price < 1) errors.price = "Harga harus bilangan bulat minimal 1.";
  if (track && (!Number.isInteger(stock) || stock < 0)) errors.stock = "Stok harus bilangan bulat 0 atau lebih.";
  if (Object.keys(errors).length > 0) {
    showFieldErrors(form, errors, (key) => PF_FIELDS[key]);
    form.querySelector(".has-error input, .has-error select")?.focus();
    return;
  }

  const button = $("#pf-submit");
  button.disabled = true;
  button.textContent = "Menyimpan…";
  try {
    // 1) Unggah foto baru (jika dipilih). Server memeriksa isi file, bukan hanya ekstensinya.
    const file = $("#pf-image").files[0];
    let imagePath = productForm.imagePath;
    if (file) {
      const upload = new FormData();
      upload.append("image", file);
      imagePath = (await api("/uploads", { method: "POST", formData: upload })).path;
    }
    // 2) Simpan produk
    const payload = {
      name: $("#pf-name").value.trim(),
      description: $("#pf-description").value.trim(),
      price,
      category: $("#pf-category").value,
      is_available: $("#pf-available").checked,
      track_stock: track,
      stock: track ? stock : productForm.editing?.stock ?? 0,
      image: imagePath,
    };
    if (productForm.editing) await api(`/products/${productForm.editing.id}`, { method: "PATCH", json: payload });
    else await api("/products", { method: "POST", json: payload });
    closeDialog($("#product-dialog"));
    showToast(productForm.editing ? "Produk diperbarui." : "Produk ditambahkan.");
    if (state.tab === "products") showTab("products");
  } catch (error) {
    if (error.code === "VALIDATION_ERROR" && error.details?.fields) {
      const leftovers = showFieldErrors(form, error.details.fields, (key) => PF_FIELDS[key]);
      setAlert($("#pf-alert"), "Periksa kembali isian yang ditandai.", leftovers);
    } else {
      setAlert($("#pf-alert"), error.message);
    }
  } finally {
    button.disabled = false;
    button.textContent = "Simpan";
  }
}

function initProductForm() {
  $("#product-form").addEventListener("submit", submitProductForm);
  $("#pf-track").addEventListener("change", syncStockField);
  $("#pf-image").addEventListener("change", () => {
    const file = $("#pf-image").files[0];
    if (file) {
      // Pratinjau memakai data: URL (diizinkan CSP). blob: sengaja tidak dibuka di CSP agar tetap ketat.
      const reader = new FileReader();
      reader.addEventListener("load", () => setPreview(String(reader.result)));
      reader.readAsDataURL(file);
    }
  });
  $("#pf-remove-image").addEventListener("click", () => {
    productForm.imagePath = null;
    $("#pf-image").value = "";
    setPreview(null);
  });
}

// ================================================================== PESAN MASUK
async function renderMessages(root, token) {
  const f = state.messages;
  const rerender = () => {
    root.replaceChildren(loading());
    renderMessages(root, token);
  };
  let data;
  try {
    data = await api(`/messages?page=${f.page}${f.unread ? "&unread=1" : ""}`);
  } catch (error) {
    if (token === tabToken) root.replaceChildren(errorState(error, rerender));
    return;
  }
  if (token !== tabToken) return;
  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size));

  const cards = data.items.map((message) =>
    h(
      "article",
      { class: `message${message.is_read ? " read" : ""}` },
      h("header", {}, h("strong", { text: message.name }), h("span", { text: fmtDateTime(message.created_at) })),
      h("p", { text: message.message }),
      h(
        "div",
        { class: "row-actions" },
        message.phone ? h("a", { class: "btn-secondary btn-small", href: `https://wa.me/${message.phone}`, target: "_blank", rel: "noopener noreferrer", text: `Balas via WhatsApp (+${message.phone})` }) : null,
        message.email ? h("a", { class: "btn-secondary btn-small", href: `mailto:${message.email}`, text: `Email ${message.email}` }) : null,
        h("button", {
          type: "button",
          class: "btn-secondary btn-small",
          text: message.is_read ? "Tandai belum dibaca" : "Tandai sudah dibaca",
          onclick: async () => {
            try {
              await api(`/messages/${message.id}`, { method: "PATCH", json: { is_read: !message.is_read } });
              refreshBadges();
              rerender();
            } catch (error) {
              showToast(error.message, { error: true });
            }
          },
        }),
      ),
    ),
  );

  root.replaceChildren(
    h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Pesan Masuk" }), h("p", { class: "page-note", text: `Dari formulir kontak di situs. ${data.unread} belum dibaca.` }))),
    h(
      "div",
      { class: "filters" },
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: f.unread ? true : null, onchange: (event) => { state.messages = { unread: event.target.checked, page: 1 }; rerender(); } }), "Hanya yang belum dibaca"),
    ),
    ...(cards.length ? cards : [h("p", { class: "empty-state", text: "Belum ada pesan." })]),
    h(
      "div",
      { class: "pager" },
      h("span", { text: `${data.total} pesan · halaman ${data.page} dari ${totalPages}` }),
      h(
        "div",
        { class: "buttons" },
        h("button", { type: "button", class: "btn-secondary btn-small", disabled: data.page <= 1 ? true : null, onclick: () => { state.messages.page -= 1; rerender(); }, text: "Sebelumnya" }),
        h("button", { type: "button", class: "btn-secondary btn-small", disabled: data.page >= totalPages ? true : null, onclick: () => { state.messages.page += 1; rerender(); }, text: "Berikutnya" }),
      ),
    ),
  );
}

// ================================================================== PENGATURAN (owner)
const LONG_TEXT_KEYS = new Set(["business_description", "address", "opening_hours", "delivery_area", "payment_transfer_instructions"]);
const SETTING_HINTS = {
  whatsapp_number: "Contoh: 081234567890. Dipakai untuk tombol WhatsApp di situs. Kosongkan jika belum ada — tombol tidak akan ditampilkan.",
  address: "Tampil di bagian Kontak. Kosongkan jika belum ingin ditampilkan.",
  opening_hours: "Contoh: Setiap hari 08.00–20.00 WIB.",
  min_order_amount: "0 berarti tanpa minimum.",
  delivery_fee: "Ongkos kirim tetap (flat) untuk semua pesanan yang diantar.",
  payment_transfer_instructions: "Wajib diisi jika transfer manual diaktifkan. Tampil ke pelanggan setelah memesan.",
  payment_qris_enabled: "Hanya berpengaruh jika gateway sudah dikonfigurasi di server (lihat kotak “Pembayaran QRIS” di atas). Kunci rahasia gateway TIDAK diatur di sini, melainkan di file .env server.",
  low_stock_threshold: "Menu yang stoknya dihitung dan sisanya ≤ angka ini muncul di daftar “Stok menipis” pada Ringkasan. Isi 0 untuk hanya memperingatkan saat habis.",
  social_instagram: "Contoh: https://instagram.com/akunanda",
  social_facebook: "Contoh: https://facebook.com/akunanda",
  social_twitter: "Contoh: https://x.com/akunanda",
};

async function renderSettings(root, token) {
  let data;
  try {
    data = await api("/settings");
  } catch (error) {
    if (token === tabToken) root.replaceChildren(errorState(error, () => renderSettings(root, token)));
    return;
  }
  if (token !== tabToken) return;
  const { settings, fields, payment } = data;

  const groups = new Map();
  for (const field of fields) {
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(field);
  }

  let logoPath = settings.logo_image || "";

  const fieldEl = (field) => {
    const id = `set-${field.key}`;
    const value = settings[field.key];
    const hint = SETTING_HINTS[field.key] ? h("p", { class: "field-hint", id: `${id}-hint`, text: SETTING_HINTS[field.key] }) : null;
    const error = h("p", { class: "field-error", id: `${id}-error` });
    if (field.type === "boolean") {
      return h("div", { class: "field" }, h("label", { class: "check" }, h("input", { id, name: field.key, type: "checkbox", checked: value ? true : null }), field.label), hint, error);
    }
    if (field.key === "logo_image") {
      const preview = h("img", { class: "image-preview", id: "set-logo-preview", alt: "Pratinjau logo", width: 96, height: 96, hidden: logoPath ? null : true, src: logoPath || null });
      const fileInput = h("input", { id, type: "file", accept: "image/jpeg,image/png,image/webp" });
      const removeBtn = h("button", { type: "button", class: "link-btn", hidden: logoPath ? null : true, text: "Hapus logo", onclick: () => { logoPath = ""; fileInput.value = ""; preview.hidden = true; removeBtn.hidden = true; } });
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files[0];
        if (!file) return;
        try {
          const upload = new FormData();
          upload.append("image", file);
          logoPath = (await api("/uploads", { method: "POST", formData: upload })).path;
          preview.src = logoPath;
          preview.hidden = false;
          removeBtn.hidden = false;
          showToast("Logo diunggah. Klik “Simpan pengaturan” untuk menerapkan.");
        } catch (uploadError) {
          showToast(uploadError.message, { error: true });
        }
      });
      return h("div", { class: "field" }, h("label", { for: id, text: field.label }), h("div", { class: "image-field" }, preview, h("div", {}, fileInput, removeBtn)), error);
    }
    const common = { id, name: field.key, "aria-describedby": `${id}-error${hint ? ` ${id}-hint` : ""}` };
    const input =
      LONG_TEXT_KEYS.has(field.key)
        ? h("textarea", { ...common, rows: 3 }, value)
        : field.type === "integer"
          ? h("input", { ...common, type: "number", inputmode: "numeric", min: 0, step: 1, value: String(value) })
          : h("input", { ...common, type: "text", value: String(value ?? "") });
    return h("div", { class: "field" }, h("label", { for: id, text: field.label }), input, hint, error);
  };

  const form = h(
    "form",
    { class: "settings-form", novalidate: true, onsubmit: async (event) => {
      event.preventDefault();
      clearFieldErrors(form);
      setAlert(alertBox, "");
      const payload = {};
      for (const field of fields) {
        if (field.key === "logo_image") payload[field.key] = logoPath;
        else if (field.type === "boolean") payload[field.key] = form.elements[field.key].checked;
        else if (field.type === "integer") payload[field.key] = Number(form.elements[field.key].value);
        else payload[field.key] = form.elements[field.key].value;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "Menyimpan…";
      try {
        await api("/settings", { method: "PUT", json: payload });
        showToast("Pengaturan disimpan dan langsung berlaku di situs.");
      } catch (error) {
        if (error.details?.fields) {
          const leftovers = showFieldErrors(form, error.details.fields, (key) => `set-${key}`);
          setAlert(alertBox, error.message, leftovers);
          form.querySelector(".has-error input, .has-error textarea")?.focus();
        } else {
          setAlert(alertBox, error.message);
        }
        alertBox.scrollIntoView({ block: "nearest" });
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "Simpan pengaturan";
      }
    } },
  );
  const alertBox = h("div", { class: "form-alert", role: "alert", hidden: true });
  const saveBtn = h("button", { type: "submit", class: "checkout-btn", text: "Simpan pengaturan" });
  form.append(alertBox);
  for (const [group, items] of groups) {
    form.append(h("fieldset", {}, h("legend", { text: group }), ...items.map(fieldEl)));
  }
  form.append(h("div", { class: "sticky-actions" }, saveBtn));

  root.replaceChildren(
    h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Pengaturan Bisnis" }), h("p", { class: "page-note", text: "Isi data bisnis Anda di sini. Data yang dikosongkan tidak akan ditampilkan di situs — tidak ada data bawaan yang dikarang." }))),
    paymentInfoBox(payment),
    form,
  );
}

/** Kotak baca-saja: konfigurasi gateway pembayaran di server (TANPA kunci rahasia). */
function paymentInfoBox(payment) {
  if (!payment) return document.createDocumentFragment();
  const modeText = { live: "LIVE (uang sungguhan)", sandbox: "SANDBOX (uji coba, tanpa uang sungguhan)", mock: "MOCK (simulasi lokal, bukan QRIS sah)" };
  const dt = dtRow;
  return h(
    "section",
    { class: "panel", id: "payment-config" },
    h("h3", { text: "Pembayaran QRIS (konfigurasi server)" }),
    h(
      "dl",
      { class: "detail-grid" },
      ...dt("Status", payment.configured ? pill("Terkonfigurasi", "ok") : pill("Belum aktif", "warn")),
      ...dt("Penyedia", payment.provider ?? "-"),
      ...dt("Mode", payment.mode ? (modeText[payment.mode] ?? payment.mode) : "-"),
      ...dt("URL notifikasi (webhook)", payment.webhook_url ? h("code", { text: payment.webhook_url }) : "Belum diketahui — isi PAYMENT_WEBHOOK_URL atau APP_ORIGIN di .env"),
      ...dt("Masa berlaku kode QR", `${payment.expiry_minutes} menit`),
      ...dt("Verifikasi ulang ke API status", payment.verify_with_status_api ? "Ya" : "Tidak"),
    ),
    ...payment.warnings.map((text) => callout("warn", text)),
    h("p", { class: "page-note", text: "Kunci/kredensial gateway hanya ada di file .env server dan tidak pernah ditampilkan atau disimpan lewat dashboard ini." }),
  );
}

// ================================================================== UBAH PASSWORD
function initPasswordForm() {
  $("#open-password").addEventListener("click", () => {
    $("#password-form").reset();
    setAlert($("#pw-alert"), "");
    openDialog($("#password-dialog"));
    $("#pw-current").focus();
  });
  $("#password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = $("#pw-current").value;
    const next = $("#pw-new").value;
    if (next !== $("#pw-confirm").value) return setAlert($("#pw-alert"), "Password baru dan pengulangannya tidak sama.");
    if (next.length < 12) return setAlert($("#pw-alert"), "Password baru minimal 12 karakter.");
    const button = $("#pw-submit");
    button.disabled = true;
    try {
      await api("/password", { method: "POST", json: { current_password: current, new_password: next } });
      closeDialog($("#password-dialog"));
      showToast("Password berhasil diubah.");
    } catch (error) {
      const detail = error.details?.fields ? Object.values(error.details.fields) : [];
      setAlert($("#pw-alert"), error.message, detail.filter((text) => text !== error.message));
    } finally {
      button.disabled = false;
    }
  });
}

// ================================================================== MULAI
async function startApp() {
  showApp();
  try {
    const config = await (await fetch("/api/config", { headers: { Accept: "application/json" } })).json();
    state.categories = config.categories ?? [];
  } catch {
    state.categories = [];
  }
  refreshBadges();
  const wanted = location.hash.replace("#", "");
  await showTab(TABS[wanted] ? wanted : "summary");
}

async function init() {
  initDialogs();
  initProductForm();
  initPasswordForm();
  $("#login-form").addEventListener("submit", handleLogin);
  $("#logout-btn").addEventListener("click", handleLogout);
  $("#admin-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) showTab(tab.dataset.tab, { focus: true });
  });
  window.addEventListener("hashchange", () => {
    const name = location.hash.replace("#", "");
    if (state.user && TABS[name] && name !== state.tab) showTab(name);
  });

  // Cek apakah sudah ada sesi login yang masih berlaku (cookie HttpOnly).
  try {
    const session = await api("/session", { quiet401: true });
    state.user = session.user;
    state.csrf = session.csrf_token;
    await startApp();
  } catch {
    showLogin();
  }
}

init();
