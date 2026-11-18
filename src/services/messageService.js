// Pesan dari formulir kontak di halaman publik.
import { notFound } from '../utils/errors.js';

export async function createContactMessage(db, { name, email, phone, message }) {
  const [result] = await db.execute(
    'INSERT INTO contact_messages (name, email, phone, message) VALUES (?, ?, ?, ?)',
    [name, email || null, phone || null, message],
  );
  return result.insertId;
}

export async function listContactMessages(db, { unreadOnly = false, page = 1, pageSize = 20 } = {}) {
  const where = unreadOnly ? 'WHERE is_read = 0' : '';
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM contact_messages ${where}`);
  const [[{ unread }]] = await db.query('SELECT COUNT(*) AS unread FROM contact_messages WHERE is_read = 0');
  const [rows] = await db.query(
    `SELECT id, name, email, phone, message, is_read, created_at
       FROM contact_messages ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [pageSize, (page - 1) * pageSize],
  );
  return {
    items: rows.map((row) => ({ ...row, is_read: Boolean(row.is_read) })),
    page,
    page_size: pageSize,
    total,
    unread,
  };
}

export async function setMessageRead(db, id, isRead) {
  const [result] = await db.execute('UPDATE contact_messages SET is_read = ? WHERE id = ?', [isRead ? 1 : 0, id]);
  if (result.affectedRows === 0) throw notFound('Pesan tidak ditemukan.');
}
