import { encryptEntry, decryptEntry } from '../crypto';

// Reuses encryptEntry/decryptEntry as-is: they already do exactly
// "Brotli compress then AEAD encrypt any JSON value", which is the whole
// cloud backup pipeline (see docs/crypto.md, Cloud Backup). backupKeyBytes
// plays the role entryKey plays for a normal entry.

export async function buildCloudBackupBlob({ username, entries, trash }, backupKeyBytes) {
  const exportObj = { version: 1, username, data: entries, trash };
  return encryptEntry(exportObj, backupKeyBytes);
}

export async function decryptCloudBackupBlob(blobBytes, backupKeyBytes) {
  return decryptEntry(blobBytes, backupKeyBytes);
}
