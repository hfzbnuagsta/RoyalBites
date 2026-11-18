// Membuat akun admin (atau mereset password):  npm run admin:create
//
// Cara pakai (interaktif — password diketik tanpa tampil di layar):
//   npm run admin:create
//   npm run admin:create -- --role=staff
//   npm run admin:create -- --reset        (ganti password akun yang sudah ada)
//
// Untuk otomatisasi (CI/provisioning) bisa memakai variabel lingkungan ADMIN_USERNAME dan ADMIN_PASSWORD.
// Jangan menulis password sebagai argumen perintah: argumen terlihat di riwayat shell dan daftar proses.
import readline from "node:readline";
import { Writable } from "node:stream";
import dotenv from "dotenv";
import { assertRunnable, loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import {
  assertPasswordPolicy,
  createAdminUser,
  hashPassword,
} from "../src/services/authService.js";

dotenv.config({ quiet: true });

const args = process.argv.slice(2);
const reset = args.includes("--reset");
const roleArg =
  args.find((arg) => arg.startsWith("--role="))?.split("=")[1] ?? "owner";

/** Mengajukan pertanyaan di terminal. Jika hidden=true, ketikan tidak ditampilkan. */
function createPrompter() {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  const ask = (question, { hidden = false } = {}) =>
    new Promise((resolve) => {
      process.stdout.write(question);
      muted = hidden;
      rl.question("", (answer) => {
        muted = false;
        if (hidden) process.stdout.write("\n");
        resolve(answer);
      });
    });
  return { ask, close: () => rl.close() };
}

const config = loadConfig();
const pool = createPool(config.db);

try {
  assertRunnable(config);
  if (!["owner", "staff"].includes(roleArg))
    throw new Error('Role harus "owner" atau "staff".');

  let username = process.env.ADMIN_USERNAME?.trim().toLowerCase();
  let password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    if (!process.stdin.isTTY) {
      throw new Error(
        "Jalankan di terminal interaktif, atau isi ADMIN_USERNAME dan ADMIN_PASSWORD.",
      );
    }
    const prompter = createPrompter();
    console.log(
      "Password minimal 12 karakter, tidak boleh umum/mudah ditebak, dan tidak boleh memuat username.",
    );
    username = (await prompter.ask("Username (huruf kecil/angka): "))
      .trim()
      .toLowerCase();
    password = await prompter.ask("Password: ", { hidden: true });
    const confirmation = await prompter.ask("Ulangi password: ", {
      hidden: true,
    });
    prompter.close();
    if (password !== confirmation)
      throw new Error("Password dan konfirmasinya tidak sama.");
  }

  if (reset) {
    assertPasswordPolicy(password, username);
    const passwordHash = await hashPassword(password, config.bcryptCost);
    const [result] = await pool.execute(
      "UPDATE admin_users SET password_hash = ?, is_active = 1 WHERE username = ?",
      [passwordHash, username],
    );
    if (result.affectedRows === 0)
      throw new Error(`Username "${username}" tidak ditemukan.`);
    // Paksa login ulang di semua perangkat.
    await pool.execute(
      "DELETE FROM admin_sessions WHERE admin_user_id = (SELECT id FROM admin_users WHERE username = ?)",
      [username],
    );
    console.log(
      `Password "${username}" berhasil diganti. Semua sesi login lama dikeluarkan.`,
    );
  } else {
    const user = await createAdminUser(pool, config, {
      username,
      password,
      role: roleArg,
    });
    console.log(
      `Akun ${user.role} "${user.username}" berhasil dibuat. Silakan login di /admin/`,
    );
  }
} catch (error) {
  console.error(`Gagal: ${error.sqlMessage || error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
