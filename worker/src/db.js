export async function getUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
}

export async function getUserById(db, id) {
  return db.prepare(
    'SELECT id, email, username, user_master_key FROM users WHERE id = ?',
  ).bind(id).first();
}

export async function updateUserMasterKey(db, userId, blob) {
  await db.prepare('UPDATE users SET user_master_key = ? WHERE id = ?').bind(blob, userId).run();
}

export async function getEntries(db, userId) {
  const { results } = await db.prepare(
    'SELECT id, entry_key, value FROM entries WHERE user_id = ?',
  ).bind(userId).all();
  return results;
}

export async function getEntryById(db, userId, entryId) {
  return db.prepare(
    'SELECT id, entry_key, value FROM entries WHERE id = ? AND user_id = ?',
  ).bind(entryId, userId).first();
}

export async function createEntry(db, id, userId, entryKey, value) {
  await db.prepare(
    'INSERT INTO entries (id, user_id, entry_key, value) VALUES (?, ?, ?, ?)',
  ).bind(id, userId, entryKey, value).run();
}

export async function updateEntry(db, id, userId, entryKey, value) {
  await db.prepare(
    "UPDATE entries SET entry_key = ?, value = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
  ).bind(entryKey, value, id, userId).run();
}

export async function deleteEntry(db, userId, entryId) {
  await db.prepare(
    'DELETE FROM entries WHERE id = ? AND user_id = ?',
  ).bind(entryId, userId).run();
}
