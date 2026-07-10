import { useState, useEffect, useCallback } from 'react';
import SpinnerBtn from './SpinnerBtn';
import { buildExportData, fetchUserEntries, getUsername, getVaultStats, getBackupKeyBytes, getBackupDestinations } from '../db';
import { buildCloudBackupBlob } from '../lib/backup';
import { uploadAllBackupDestinations } from '../lib/s3';
import KeyRotation from './KeyRotation';

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value % 1 === 0 ? value : value.toFixed(2)} ${units[i]}`;
}

function StatsHeading({ children }) {
  return <div className="text-muted small fw-semibold mb-1">{children}</div>;
}

function StatsRow({ label, value, note = null }) {
  return (
    <tr>
      <td className="text-muted">{label}</td>
      <td className="fw-semibold">
        {value}
        {note && <span className="text-muted fw-normal ms-2 small">({note})</span>}
      </td>
    </tr>
  );
}

function StatsTable({ rows, className = 'table table-sm mb-3' }) {
  return (
    <table className={className}>
      <tbody>
        {rows.map((row) => (
          <StatsRow key={row.label} label={row.label} value={row.value} note={row.note} />
        ))}
      </tbody>
    </table>
  );
}

function AboutPage() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const { entries, trash } = await fetchUserEntries();
        const vaultStats = getVaultStats(entries, trash);

        let totalBytes = 0;
        let withPassword = 0, withUsername = 0, withNotes = 0;
        let withUrls = 0, totalUrls = 0;
        let withTotp = 0, totalTotp = 0;
        let withCustomFields = 0, totalCustomFields = 0;
        let withTags = 0;
        let totalCommits = 0, maxCommits = 0, neverEdited = 0;
        const tagCounts = new Map();
        const entryList = [];

        for (const entry of entries) {
          const entryBytes = new TextEncoder().encode(JSON.stringify(entry)).length;
          totalBytes += entryBytes;

          if (entry.password) withPassword++;
          if (entry.username) withUsername++;
          if (entry.notes) withNotes++;
          if (entry.urls?.length) { withUrls++; totalUrls += entry.urls.length; }
          if (entry.totpSecrets?.length) { withTotp++; totalTotp += entry.totpSecrets.length; }
          if (entry.customFields?.length) { withCustomFields++; totalCustomFields += entry.customFields.length; }
          if (entry.tags?.length) {
            withTags++;
            entry.tags.forEach(t => tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1));
          }

          const commitCount = entry.history?.length ?? 1;
          totalCommits += commitCount;
          if (commitCount > maxCommits) maxCommits = commitCount;
          if (commitCount === 1) neverEdited++;

          entryList.push({ bytes: entryBytes, title: entry.title || null, username: entry.username || null });
        }

        entryList.sort((a, b) => b.bytes - a.bytes);

        const topTags = [...tagCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([tag, count]) => ({ tag, count }));

        const count = vaultStats.entryCount;
        const trashCount = vaultStats.trashCount;
        setStats({
          count,
          trashCount,
          entriesJsonSize: totalBytes,
          avgBytes: count ? Math.round(totalBytes / count) : 0,
          decryptedCount: count,
          withPassword, withUsername, withNotes,
          withUrls, totalUrls,
          withTotp, totalTotp,
          withCustomFields, totalCustomFields,
          withTags,
          avgCommits: count ? (totalCommits / count).toFixed(1) : '—',
          maxCommits,
          neverEdited,
          topTags,
          top5: entryList.slice(0, 5),
        });
      } catch {
        setStats(null);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

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
          <StatsHeading>Overview</StatsHeading>
          <StatsTable
            rows={[
              { label: 'Entries', value: stats.count },
              { label: 'Trash entries', value: stats.trashCount },
              { label: 'Total entries size', value: formatBytes(stats.entriesJsonSize) },
              { label: 'Avg entry size', value: formatBytes(stats.avgBytes) },
            ]}
          />

          {stats.decryptedCount > 0 && (<>
            <StatsHeading>Field coverage</StatsHeading>
            <StatsTable
              rows={[
                { label: 'Password', value: `${stats.withPassword} / ${stats.decryptedCount}` },
                { label: 'Username', value: `${stats.withUsername} / ${stats.decryptedCount}` },
                { label: 'Notes', value: `${stats.withNotes} / ${stats.decryptedCount}` },
                { label: 'URLs', value: `${stats.withUrls} / ${stats.decryptedCount}`, note: stats.totalUrls > 0 ? `${stats.totalUrls} total` : null },
                { label: 'TOTP secrets', value: `${stats.withTotp} / ${stats.decryptedCount}`, note: stats.totalTotp > 0 ? `${stats.totalTotp} total` : null },
                { label: 'Custom fields', value: `${stats.withCustomFields} / ${stats.decryptedCount}`, note: stats.totalCustomFields > 0 ? `${stats.totalCustomFields} total` : null },
                { label: 'Tags', value: `${stats.withTags} / ${stats.decryptedCount}` },
              ]}
            />

            <StatsHeading>Version history</StatsHeading>
            <StatsTable
              rows={[
                { label: 'Avg commits per entry', value: stats.avgCommits },
                { label: 'Max commits on one entry', value: stats.maxCommits },
                { label: 'Never edited', value: stats.neverEdited },
              ]}
            />

            {stats.topTags.length > 0 && (<>
              <StatsHeading>Top tags</StatsHeading>
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
            <StatsHeading>Top {stats.top5.length} largest entries</StatsHeading>
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

function ExportPage() {
  const [exporting, setExporting] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupResults, setBackupResults] = useState(null);
  const [backupError, setBackupError] = useState(null);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const { entries, trash } = await fetchUserEntries();
      const exportObj = buildExportData({ username: getUsername(), entries, trash });
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
  }, []);

  const destinations = getBackupDestinations();
  const hasCloudDestinations = Boolean(destinations.r2_config) || destinations.s3_config.length > 0;

  const handleCloudBackup = useCallback(async () => {
    setBackingUp(true);
    setBackupResults(null);
    setBackupError(null);
    try {
      const { entries, trash } = await fetchUserEntries();
      const backupKeyBytes = getBackupKeyBytes();
      const exportObj = buildExportData({ username: getUsername(), entries, trash });
      const blob = await buildCloudBackupBlob(exportObj, backupKeyBytes);
      const key = `secbits-backup-${new Date().toISOString().slice(0, 10)}.bin`;
      const results = await uploadAllBackupDestinations(destinations, blob, key);
      setBackupResults(results);
    } catch (err) {
      setBackupError(err?.message || 'Failed to back up to cloud.');
    } finally {
      setBackingUp(false);
    }
  }, [destinations]);

  return (
    <div className="p-4" style={{ maxWidth: 700 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-download me-2"></i>Export
      </h5>
      <div className="fw-semibold mb-1">Local export</div>
      <div className="text-muted small mb-2">
        Download every entry as a plain, unencrypted JSON file. No encryption is involved;
        this file is a full decrypted copy of your vault.
      </div>
      <SpinnerBtn
        className="btn btn-primary btn-sm"
        onClick={handleExport}
        busy={exporting}
        busyLabel="Exporting..."
        icon="bi-download"
      >Export all data</SpinnerBtn>

      <div className="fw-semibold mb-1 mt-4">Cloud backup</div>
      <div className="text-muted small mb-2">
        Compress and encrypt the same vault content under a dedicated backup key, then upload
        it to Cloudflare R2 and every configured S3 compatible destination. Each destination
        is uploaded independently.
      </div>
      {!hasCloudDestinations ? (
        <div className="text-muted small fst-italic">
          No cloud backup destinations configured; nothing to back up to.
        </div>
      ) : (
        <SpinnerBtn
          className="btn btn-outline-primary btn-sm"
          onClick={handleCloudBackup}
          busy={backingUp}
          busyLabel="Backing up..."
          icon="bi-cloud-upload"
        >Back up to cloud</SpinnerBtn>
      )}
      {backupError && <div className="alert alert-danger small py-2 mt-2 mb-0">{backupError}</div>}
      {backupResults && (
        <ul className="list-unstyled small mt-2 mb-0">
          {backupResults.map((r) => (
            <li key={r.destination} className={r.ok ? 'text-success' : 'text-danger'}>
              <i className={`bi ${r.ok ? 'bi-check-circle' : 'bi-x-circle'} me-1`}></i>
              {r.destination}{r.ok ? ' uploaded' : `: ${r.error}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SecurityPage() {
  return (
    <div className="p-4" style={{ maxWidth: 760 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-shield-lock me-2"></i>Security
      </h5>
      <p className="text-muted small mb-3">
        Rotate the keys protecting your vault if you suspect any of them may be compromised.
      </p>
      <KeyRotation />
    </div>
  );
}

function SettingsPanel({ page }) {
  if (page === 'export') return <ExportPage />;
  if (page === 'security') return <SecurityPage />;
  if (page === 'about') return <AboutPage />;

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
