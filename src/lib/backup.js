import { encryptEntry } from '../crypto';

// Reuses encryptEntry as-is: it already does exactly "Brotli compress then
// AEAD encrypt any JSON value", which is the whole cloud backup pipeline
// (see docs/crypto.md, Cloud Backup). backupMasterKeyBytes plays the role
// entryKey plays for a normal entry, except it's a config only secret
// rather than something wrapped and stored in InstantDB.
//
// Takes the same export object buildExportData() produces (version,
// user_master_key, data, trash, each entry carrying its entry_key) rather
// than reassembling its own shape, so local export and cloud backup can
// never drift apart.

export async function buildCloudBackupBlob(exportObj, backupMasterKeyBytes) {
  return encryptEntry(exportObj, backupMasterKeyBytes);
}
