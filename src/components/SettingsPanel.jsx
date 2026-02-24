import { useState, useEffect, useCallback } from 'react';
import { fetchRawUserDocs, fetchUser, getUserMasterKey } from '../api';
import { unwrapEntryKey, decryptEntryHistoryWithDocKey, bytesToB64 } from '../crypto';

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

export function buildExportData({ userId, userData, userMasterKey, decryptedDocs }) {
  return {
    user_id: userId,
    username: userData?.username || null,
    user_master_key_b64: userMasterKey ? bytesToB64(userMasterKey) : null,
    data: decryptedDocs,
  };
}

function ExportPage({ userId }) {
  const [exporting, setExporting] = useState(false);

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
          if (valueToBytes(d.value)) {
            entry.value = await decryptEntryHistoryWithDocKey(docKeyBytes, d.value);
          } else {
            entry.value = d.value;
          }
        } else {
          entry.entry_key_b64 = entryKeyBytes ? bytesToB64(entryKeyBytes) : d.entry_key;
          entry.value = d.value;
        }
        decryptedDocs.push(entry);
      }
      const exportData = buildExportData({ userId, userData, userMasterKey, decryptedDocs });
      const json = JSON.stringify(exportData, null, 2);
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

  return (
    <div className="p-4" style={{ maxWidth: 500 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-download me-2"></i>Export
      </h5>
      <p className="text-muted small">
        Export all entries from your database as a decrypted JSON file.
      </p>
      <button className="btn btn-primary" onClick={handleExport} disabled={exporting}>
        {exporting ? (
          <><span className="spinner-border spinner-border-sm me-1"></span>Exporting...</>
        ) : (
          <><i className="bi bi-download me-1"></i>Export All Data</>
        )}
      </button>
    </div>
  );
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

function SettingsPanel({ page, userId }) {
  if (page === 'export') return <ExportPage userId={userId} />;
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
