export async function provisionUser(client, firebaseUid) {
  await client.execute({
    sql: 'INSERT INTO users (firebase_uid) VALUES (?) ON CONFLICT(firebase_uid) DO NOTHING',
    args: [firebaseUid],
  });
}

export async function getUserByFirebaseUid(client, firebaseUid) {
  const rs = await client.execute({
    sql: 'SELECT user_id, firebase_uid, username, user_master_key FROM users WHERE firebase_uid = ?',
    args: [firebaseUid],
  });
  return rs.rows[0] ?? null;
}

export async function updateUserProfile(client, userId, userMasterKeyBlob, username) {
  const hasUsername = typeof username === 'string' && username.trim().length > 0;
  if (hasUsername) {
    await client.execute({
      sql: 'UPDATE users SET user_master_key = ?, username = ? WHERE user_id = ?',
      args: [userMasterKeyBlob, username.trim(), userId],
    });
    return;
  }
  await client.execute({
    sql: 'UPDATE users SET user_master_key = ? WHERE user_id = ?',
    args: [userMasterKeyBlob, userId],
  });
}

export async function getEntries(client, userId) {
  const rs = await client.execute({
    sql: 'SELECT id, entry_key, value FROM entries WHERE user_id = ?',
    args: [userId],
  });
  return rs.rows;
}

export async function getEntryById(client, userId, entryId) {
  const rs = await client.execute({
    sql: 'SELECT id, entry_key, value FROM entries WHERE id = ? AND user_id = ?',
    args: [entryId, userId],
  });
  return rs.rows[0] ?? null;
}

export async function createEntry(client, id, userId, entryKey, value) {
  await client.execute({
    sql: 'INSERT INTO entries (id, user_id, entry_key, value) VALUES (?, ?, ?, ?)',
    args: [id, userId, entryKey, value],
  });
}

export async function updateEntry(client, id, userId, entryKey, value) {
  const rs = await client.execute({
    sql: "UPDATE entries SET entry_key = ?, value = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    args: [entryKey, value, id, userId],
  });
  return rs.rowsAffected;
}

export async function deleteEntry(client, userId, entryId) {
  const rs = await client.execute({
    sql: 'DELETE FROM entries WHERE id = ? AND user_id = ?',
    args: [entryId, userId],
  });
  return rs.rowsAffected;
}

export async function replaceEntriesForUser(client, userId, entries) {
  const stmts = [
    { sql: 'DELETE FROM entries WHERE user_id = ?', args: [userId] },
  ];

  for (const entry of entries) {
    stmts.push({
      sql: 'INSERT INTO entries (id, user_id, entry_key, value) VALUES (?, ?, ?, ?)',
      args: [entry.id, userId, entry.entryKeyBlob, entry.valueBlob],
    });
  }

  await client.batch(stmts, 'write');
}
