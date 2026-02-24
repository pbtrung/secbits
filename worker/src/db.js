export async function getUserById(db, id) {
  return db.prepare(
    'SELECT id, username, user_master_key FROM users WHERE id = ?',
  ).bind(id).first();
}

export async function provisionUser(db, userId) {
  await db.prepare(
    'INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING',
  ).bind(userId).run();
}

export async function updateUserProfile(db, userId, userMasterKeyBlob, username) {
  const hasUsername = typeof username === 'string' && username.trim().length > 0;
  if (hasUsername) {
    await db.prepare(
      'UPDATE users SET user_master_key = ?, username = ? WHERE id = ?',
    ).bind(userMasterKeyBlob, username.trim(), userId).run();
    return;
  }

  await db.prepare(
    'UPDATE users SET user_master_key = ? WHERE id = ?',
  ).bind(userMasterKeyBlob, userId).run();
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
  const result = await db.prepare(
    "UPDATE entries SET entry_key = ?, value = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
  ).bind(entryKey, value, id, userId).run();
  return result.meta?.changes ?? 0;
}

export async function deleteEntry(db, userId, entryId) {
  const result = await db.prepare(
    'DELETE FROM entries WHERE id = ? AND user_id = ?',
  ).bind(entryId, userId).run();
  return result.meta?.changes ?? 0;
}
