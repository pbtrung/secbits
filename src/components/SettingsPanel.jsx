import { useState, useEffect, useCallback } from 'react';
import { fetchRawUserDocs, fetchUser, getBackupTargets, getUserMasterKey } from '../api';
import { unwrapEntryKey, decryptEntryHistoryWithDocKey, bytesToB64 } from '../crypto';
import {
  buildExportData,
  describeTarget,
  getAutoBackupEnabled,
  getLastBackupAt,
  runBackupNow,
  runRestore,
  setAutoBackupEnabled,
} from '../backup';

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value % 1 === 0 ? value : value.toFixed(2)} ${units[i]}`;
}

function valueToBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value.toUint8Array === 'function') return value.toUint8Array();
  return null;
}

function valueByteLength(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value).length;
  const bytes = valueToBytes(value);
  if (bytes) return bytes.length;
  return new Blob([JSON.stringify(value ?? null)]).size;
}

function AboutPage({ userId }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const docs = await fetchRawUserDocs();
        const userMasterKey = getUserMasterKey();

        let totalBytes = 0;
        let decryptedCount = 0;
        let withPassword = 0, withUsername = 0, withNotes = 0;
        let withUrls = 0, totalUrls = 0;
        let withTotp = 0, totalTotp = 0;
        let withCustomFields = 0, totalCustomFields = 0;
        let withTags = 0;
        let totalCommits = 0, maxCommits = 0, neverEdited = 0;
        const tagCounts = new Map();
        const entries = [];

        for (const doc of docs) {
          let entryBytes = 0;
          if (doc.value) entryBytes += valueByteLength(doc.value);
          if (doc.entry_key) entryBytes += valueByteLength(doc.entry_key);
          totalBytes += entryBytes;

          let title = null;
          let username = null;

          const entryKeyBytes = valueToBytes(doc.entry_key);
          if (entryKeyBytes && userMasterKey && valueToBytes(doc.value)) {
            try {
              const docKeyBytes = await unwrapEntryKey(userMasterKey, entryKeyBytes);
              const history = await decryptEntryHistoryWithDocKey(docKeyBytes, doc.value);
              const snap = history?.head_snapshot ?? {};

              title = snap.title || null;
              username = snap.username || null;
              decryptedCount++;

              if (snap.password) withPassword++;
              if (snap.username) withUsername++;
              if (snap.notes) withNotes++;
              if (snap.urls?.length) { withUrls++; totalUrls += snap.urls.length; }
              if (snap.totpSecrets?.length) { withTotp++; totalTotp += snap.totpSecrets.length; }
              if (snap.customFields?.length) { withCustomFields++; totalCustomFields += snap.customFields.length; }
              if (snap.tags?.length) {
                withTags++;
                snap.tags.forEach(t => tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1));
              }

              const commitCount = history?.commits?.length ?? 1;
              totalCommits += commitCount;
              if (commitCount > maxCommits) maxCommits = commitCount;
              if (commitCount === 1) neverEdited++;
            } catch {
              // skip field stats for this entry
            }
          }

          entries.push({ bytes: entryBytes, title, username });
        }

        entries.sort((a, b) => b.bytes - a.bytes);

        const topTags = [...tagCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([tag, count]) => ({ tag, count }));

        setStats({
          count: docs.length,
          totalBytes,
          avgBytes: docs.length ? Math.round(totalBytes / docs.length) : 0,
          decryptedCount,
          withPassword, withUsername, withNotes,
          withUrls, totalUrls,
          withTotp, totalTotp,
          withCustomFields, totalCustomFields,
          withTags,
          avgCommits: decryptedCount ? (totalCommits / decryptedCount).toFixed(1) : '—',
          maxCommits,
          neverEdited,
          topTags,
          top5: entries.slice(0, 5),
        });
      } catch {
        setStats(null);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [userId]);

  return (
    <div className="p-4" style={{ maxWidth: 500 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-info-circle me-2"></i>About
      </h5>
      {loading ? (
        <div className="text-muted">
          <span className="spinner-border spinner-border-sm me-2"></span>Loading stats...
        </div>
      ) : stats ? (
        <div>
          <div className="text-muted small fw-semibold mb-1">Overview</div>
          <table className="table table-sm mb-3">
            <tbody>
              <tr>
                <td className="text-muted">Entries</td>
                <td className="fw-semibold">{stats.count}</td>
              </tr>
              <tr>
                <td className="text-muted">Total stored size</td>
                <td className="fw-semibold">{formatBytes(stats.totalBytes)}</td>
              </tr>
              <tr>
                <td className="text-muted">Avg entry size</td>
                <td className="fw-semibold">{formatBytes(stats.avgBytes)}</td>
              </tr>
            </tbody>
          </table>

          {stats.decryptedCount > 0 && (<>
            <div className="text-muted small fw-semibold mb-1">Field coverage</div>
            <table className="table table-sm mb-3">
              <tbody>
                {[
                  ['Password', stats.withPassword, null],
                  ['Username', stats.withUsername, null],
                  ['Notes', stats.withNotes, null],
                  ['URLs', stats.withUrls, stats.totalUrls > 0 ? `${stats.totalUrls} total` : null],
                  ['TOTP secrets', stats.withTotp, stats.totalTotp > 0 ? `${stats.totalTotp} total` : null],
                  ['Custom fields', stats.withCustomFields, stats.totalCustomFields > 0 ? `${stats.totalCustomFields} total` : null],
                  ['Tags', stats.withTags, null],
                ].map(([label, n, note]) => (
                  <tr key={label}>
                    <td className="text-muted">{label}</td>
                    <td className="fw-semibold">
                      {n} / {stats.decryptedCount}
                      {note && <span className="text-muted fw-normal ms-2 small">({note})</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="text-muted small fw-semibold mb-1">Version history</div>
            <table className="table table-sm mb-3">
              <tbody>
                <tr>
                  <td className="text-muted">Avg commits per entry</td>
                  <td className="fw-semibold">{stats.avgCommits}</td>
                </tr>
                <tr>
                  <td className="text-muted">Max commits on one entry</td>
                  <td className="fw-semibold">{stats.maxCommits}</td>
                </tr>
                <tr>
                  <td className="text-muted">Never edited</td>
                  <td className="fw-semibold">{stats.neverEdited}</td>
                </tr>
              </tbody>
            </table>

            {stats.topTags.length > 0 && (<>
              <div className="text-muted small fw-semibold mb-1">Top tags</div>
              <div className="mb-3">
                {stats.topTags.map(({ tag, count }) => (
                  <span key={tag} className="badge bg-secondary me-1 mb-1">
                    {tag} <span className="opacity-75">({count})</span>
                  </span>
                ))}
              </div>
            </>)}
          </>)}

          {stats.top5.length > 0 && (<>
            <div className="text-muted small fw-semibold mb-1">Top {stats.top5.length} largest entries</div>
            <table className="table table-sm">
              <thead>
                <tr>
                  <th className="text-muted fw-normal">Title</th>
                  <th className="text-muted fw-normal">Username</th>
                  <th className="text-muted fw-normal">Size</th>
                </tr>
              </thead>
              <tbody>
                {stats.top5.map((e, i) => (
                  <tr key={i}>
                    <td className="fw-semibold">{e.title ?? <span className="text-muted fst-italic">—</span>}</td>
                    <td className="text-muted small">{e.username || <span className="fst-italic">—</span>}</td>
                    <td className="fw-semibold">{e.bytes.toLocaleString()} B</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>)}
        </div>
      ) : (
        <div className="text-danger small">Failed to load stats.</div>
      )}
    </div>
  );
}

function BackupPage({ userId }) {
  const [exporting, setExporting] = useState(false);
  const [runningBackup, setRunningBackup] = useState(false);
  const [status, setStatus] = useState('');
  const [resultRows, setResultRows] = useState([]);
  const [autoEnabled, setAutoEnabled] = useState(getAutoBackupEnabled);
  const [lastBackup, setLastBackup] = useState(getLastBackupAt);

  const targets = (getBackupTargets() || [])
    .filter((t) => t && typeof t === 'object' && t.target && t.bucket);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const [docs, userData] = await Promise.all([
        fetchRawUserDocs(),
        fetchUser(),
      ]);
      const userMasterKey = getUserMasterKey();
      const decryptedDocs = [];
      for (const d of docs) {
        const entry = { id: d.id };
        const entryKeyBytes = valueToBytes(d.entry_key);
        if (entryKeyBytes && userMasterKey) {
          const docKeyBytes = await unwrapEntryKey(userMasterKey, entryKeyBytes);
          entry.entry_key_b64 = bytesToB64(docKeyBytes);
          entry.value = valueToBytes(d.value)
            ? await decryptEntryHistoryWithDocKey(docKeyBytes, d.value)
            : d.value;
        } else {
          entry.entry_key_b64 = entryKeyBytes ? bytesToB64(entryKeyBytes) : d.entry_key;
          entry.value = d.value;
        }
        decryptedDocs.push(entry);
      }
      const exportObj = buildExportData({ userId, userData, userMasterKey, decryptedDocs });
      const json = JSON.stringify(exportObj, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `secbits-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Failed to export data.');
    } finally {
      setExporting(false);
    }
  }, [userId]);

  const handleToggleAuto = (enabled) => {
    setAutoEnabled(enabled);
    setAutoBackupEnabled(enabled);
  };

  const handleBackupNow = async () => {
    setRunningBackup(true);
    setStatus('');
    try {
      const { results } = await runBackupNow(userId);
      setResultRows(results);
      setLastBackup(getLastBackupAt());
      const okCount = results.filter((r) => r.ok).length;
      setStatus(okCount > 0 ? `Backup completed (${okCount}/${results.length} target(s) succeeded).` : 'Backup failed on all targets.');
    } catch (err) {
      setStatus(err?.message || 'Backup failed.');
      setResultRows([]);
    } finally {
      setRunningBackup(false);
    }
  };

  return (
    <div className="p-4" style={{ maxWidth: 700 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-cloud-arrow-up me-2"></i>Backup
      </h5>

      <div className="mb-4">
        <div className="fw-semibold mb-1">Export</div>
        <div className="text-muted small mb-2">
          Export all entries as a decrypted JSON file for local backup or migration.
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={handleExport}
          disabled={exporting || runningBackup}
        >
          {exporting ? (
            <><span className="spinner-border spinner-border-sm me-1"></span>Exporting...</>
          ) : (
            <><i className="bi bi-download me-1"></i>Export all data</>
          )}
        </button>
      </div>

      {targets.length === 0 ? (
        <div className="alert alert-warning small mb-0">
          No backup targets are configured in your config file.
        </div>
      ) : (
        <>
          <div className="mb-4">
            <div className="fw-semibold mb-1">Manual backup</div>
            <div className="text-muted small mb-2">Upload encrypted backup to all configured targets.</div>
            <button
              className="btn btn-primary btn-sm"
              disabled={runningBackup || exporting}
              onClick={handleBackupNow}
            >
              {runningBackup ? (
                <><span className="spinner-border spinner-border-sm me-1"></span>Backing up...</>
              ) : (
                <><i className="bi bi-cloud-upload me-1"></i>Backup now</>
              )}
            </button>
            {resultRows.length > 0 && (
              <div className="small mt-2">
                {resultRows.map((row, idx) => (
                  <div key={idx} className={row.ok ? 'text-success' : 'text-danger'}>
                    {row.ok ? 'OK' : 'ERR'} · {row.label}{row.ok ? '' : ` — ${row.error}`}
                  </div>
                ))}
              </div>
            )}
            <div className="text-muted small mt-2">
              Last backup: {lastBackup ? new Date(lastBackup).toLocaleString() : 'Never this session'}
            </div>
          </div>

          <div>
            <div className="form-check form-switch">
              <input
                className="form-check-input"
                type="checkbox"
                id="autoBackupToggle"
                checked={autoEnabled}
                onChange={(e) => handleToggleAuto(e.target.checked)}
                disabled={runningBackup || exporting}
              />
              <label className="form-check-label" htmlFor="autoBackupToggle">
                Auto-backup after save
              </label>
            </div>
            <div className="text-muted small mt-1">
              When enabled, backups are triggered after successful create, update, restore, and delete operations.
            </div>
          </div>
        </>
      )}

      {status && (
        <div className="mt-3 small">
          {status}
        </div>
      )}
    </div>
  );
}

function RestorePage({ userId, onRestoreComplete }) {
  const [runningRestore, setRunningRestore] = useState(false);
  const [status, setStatus] = useState('');
  const [sourceMode, setSourceMode] = useState('target');
  const [targetIndex, setTargetIndex] = useState(0);
  const [localFile, setLocalFile] = useState(null);

  const targets = (getBackupTargets() || [])
    .filter((t) => t && typeof t === 'object' && t.target && t.bucket);

  const usingFile = targets.length === 0 || sourceMode === 'file';

  const handleRestore = async () => {
    setRunningRestore(true);
    setStatus('');
    try {
      const source = usingFile
        ? { type: 'file', file: localFile }
        : { type: 'target', index: targetIndex };
      const result = await runRestore({
        userId,
        source,
        confirm: ({ entryCount }) => window.confirm(
          `This will replace all current entries. This cannot be undone.\n\nEntries in backup: ${entryCount}\n\nProceed with restore?`,
        ),
      });
      setStatus(`Restore completed (${result.restoredCount} entries).`);
      onRestoreComplete?.();
    } catch (err) {
      if (err?.message === 'Restore canceled') {
        setStatus('Restore canceled.');
      } else {
        setStatus(err?.message || 'Restore failed.');
      }
    } finally {
      setRunningRestore(false);
    }
  };

  return (
    <div className="p-4" style={{ maxWidth: 500 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-arrow-counterclockwise me-2"></i>Restore
      </h5>
      <p className="text-muted small">
        Restore all entries from an encrypted backup.{' '}
        <strong>This replaces all current entries and cannot be undone.</strong>
      </p>

      {targets.length > 0 && (
        <div className="mb-2">
          <select
            className="form-select form-select-sm"
            value={usingFile ? 'file' : `target:${targetIndex}`}
            onChange={(e) => {
              if (e.target.value === 'file') {
                setSourceMode('file');
              } else {
                const idx = Number(e.target.value.split(':')[1] || 0);
                setSourceMode('target');
                setTargetIndex(Number.isFinite(idx) ? idx : 0);
              }
            }}
            disabled={runningRestore}
          >
            {targets.map((target, idx) => (
              <option key={idx} value={`target:${idx}`}>
                {describeTarget(target)}
              </option>
            ))}
            <option value="file">Local file</option>
          </select>
        </div>
      )}

      {usingFile && (
        <div className="mb-2">
          <input
            type="file"
            className="form-control form-control-sm"
            accept=".bak,application/octet-stream"
            onChange={(e) => setLocalFile(e.target.files?.[0] || null)}
            disabled={runningRestore}
          />
        </div>
      )}

      <button
        className="btn btn-primary btn-sm"
        onClick={handleRestore}
        disabled={runningRestore || (usingFile && !localFile)}
      >
        {runningRestore ? (
          <><span className="spinner-border spinner-border-sm me-1"></span>Restoring...</>
        ) : (
          <><i className="bi bi-arrow-counterclockwise me-1"></i>Restore</>
        )}
      </button>

      {status && (
        <div className="mt-3 small">
          {status}
        </div>
      )}
    </div>
  );
}

function SettingsPanel({ page, userId, onRestoreComplete }) {
  if (page === 'backup') return <BackupPage userId={userId} />;
  if (page === 'restore') return <RestorePage userId={userId} onRestoreComplete={onRestoreComplete} />;
  if (page === 'about') return <AboutPage userId={userId} />;

  return (
    <div className="d-flex align-items-center justify-content-center h-100 text-muted">
      <div className="text-center">
        <i className="bi bi-gear" style={{ fontSize: '4rem' }}></i>
        <p className="mt-3">Select a setting</p>
        <p className="small">Press the gear icon again to go back</p>
      </div>
    </div>
  );
}

export default SettingsPanel;
