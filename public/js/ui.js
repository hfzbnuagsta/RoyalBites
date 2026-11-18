// Komponen antarmuka bersama: ikon, toast, dialog, dan dialog konfirmasi.

/** Mengganti <i data-feather="..."> dengan ikon SVG (dipanggil setiap kali ada DOM baru). */
export function refreshIcons() {
  if (window.feather) window.feather.replace();
}

// ------------------------------------------------------------------ Toast
const toastEl = document.querySelector("#toast");
const toastMessage = document.querySelector("#toast-message");
let toastTimer = null;

export function showToast(message, { error = false, duration = 3200 } = {}) {
  toastMessage.textContent = message;
  toastEl.classList.toggle("error", error);
  // Toast adalah "popover" agar tampil DI ATAS dialog yang sedang terbuka (keranjang, detail menu).
  // Dipanggil ulang setiap kali supaya naik ke lapisan paling atas.
  try {
    if (toastEl.matches(":popover-open")) toastEl.hidePopover();
    toastEl.showPopover();
  } catch {
    // Browser lama tanpa Popover API: toast tetap tampil lewat kelas .active di bawah.
  }
  toastEl.classList.add("active");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("active");
    try {
      if (toastEl.matches(":popover-open")) toastEl.hidePopover();
    } catch {
      // abaikan
    }
  }, duration);
}

// ------------------------------------------------------------------ Dialog
function syncBodyLock() {
  const anyOpen = [...document.querySelectorAll("dialog")].some((dialog) => dialog.open);
  document.body.classList.toggle("modal-open", anyOpen);
}

/** Menyiapkan semua <dialog>: klik latar gelap / tombol [data-close] menutup, dan body dikunci saat terbuka. */
export function initDialogs() {
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close(); // klik pada latar gelap
      if (event.target.closest("[data-close]")) dialog.close();
    });
    dialog.addEventListener("close", syncBodyLock);
  }
}

export function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
  syncBodyLock();
}

export function closeDialog(dialog) {
  if (dialog.open) dialog.close();
  syncBodyLock();
}

// ------------------------------------------------------------------ Konfirmasi
const confirmDialogEl = document.querySelector("#confirm-dialog");
const confirmTitle = document.querySelector("#confirm-title");
const confirmMessage = document.querySelector("#confirm-message");
const confirmOk = document.querySelector("#confirm-ok");

/**
 * Menampilkan dialog konfirmasi. Mengembalikan Promise<boolean>:
 * true jika pengguna menekan tombol konfirmasi, false jika batal / menutup.
 */
export function confirmAction({ title = "Konfirmasi", message, confirmLabel = "Ya, lanjutkan" }) {
  return new Promise((resolve) => {
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmOk.textContent = confirmLabel;
    confirmDialogEl.returnValue = "";
    confirmDialogEl.addEventListener("close", () => resolve(confirmDialogEl.returnValue === "ok"), { once: true });
    openDialog(confirmDialogEl);
    document.querySelector("#confirm-cancel").focus(); // fokus awal pada pilihan yang aman
  });
}
