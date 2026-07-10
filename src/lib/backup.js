import { encryptEntry, decryptEntry } from '../crypto';

// Reuses encryptEntry/decryptEntry as-is: they already do exactly
// "Brotli compress then AEAD encrypt any JSON value", which is the whole
// cloud backup pipeline (see docs/crypto.md, Cloud Backup). backupKeyBytes
// plays the role entryKey plays for a normal entry.
//
// Takes the same export object buildExportData() produces (version, umk,
// data, trash, each entry carrying its entryKey) rather than reassembling
// its own shape, so local export and cloud backup can never drift apart.

export async function buildCloudBackupBlob(exportObj, backupKeyBytes) {
  return encryptEntry(exportObj, backupKeyBytes);
}

export async function decryptCloudBackupBlob(blobBytes, backupKeyBytes) {
  return decryptEntry(blobBytes, backupKeyBytes);
}
