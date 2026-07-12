import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import SpinnerBtn from './SpinnerBtn';
import {
  buildExportData,
  fetchUserEntries,
  getUsername,
  getVaultStats,
  getBackupMasterKeyBytes,
  getBackupDestinations,
} from '../db';
import { buildCloudBackupBlob } from '../lib/backup';
import { uploadAllBackupDestinations } from '../lib/s3';
import type { UploadResult } from '../lib/s3';
import KeyRotation from './KeyRotation';
import type { Entry } from '../types';

function downloadJsonFile(obj: unknown, filename: string): void {
  const json = JSON.stringify(obj, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value % 1 === 0 ? value : value.toFixed(2)} ${units[i]}`;
}

function StatsHeading({ children }: { children: ReactNode }) {
  return <div className="text-muted small fw-semibold mb-1">{children}</div>;
}

interface StatsRowProps {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}

function StatsRow({ label, value, note = null }: StatsRowProps) {
  return (
    <tr>
      <td className="text-muted" style={{ width: '60%' }}>
        {label}
      </td>
      <td className="fw-semibold">
        {value}
        {note && <span className="text-muted fw-normal ms-2 small">({note})</span>}
      </td>
    </tr>
  );
}

// Overview, Field coverage, and Version history are each a separate
// StatsTable; without a shared fixed layout, every table auto-sizes its
// own label column from its own longest label, so the value column lands
// at a different x position per section instead of lining up.
function StatsTable({ rows, className = 'table table-sm mb-3' }: { rows: StatsRowProps[]; className?: string }) {
  return (
    <table className={className} style={{ tableLayout: 'fixed', width: '100%' }}>
      <tbody>
        {rows.map((row) => (
          <StatsRow key={row.label} label={row.label} value={row.value} note={row.note} />
        ))}
      </tbody>
    </table>
  );
}

interface FieldCoverageStats {
  withPassword: number;
  withUsername: number;
  withNotes: number;
  withUrls: number;
  totalUrls: number;
  withTotp: number;
  totalTotp: number;
  withCustomFields: number;
  totalCustomFields: number;
  withTags: number;
  tagCounts: Map<string, number>;
}

function accumulateFieldCoverage(stats: FieldCoverageStats, entry: Entry): void {
  if (entry.password) stats.withPassword++;
  if (entry.username) stats.withUsername++;
  if (entry.notes) stats.withNotes++;
  if (entry.urls?.length) {
    stats.withUrls++;
    stats.totalUrls += entry.urls.length;
  }
  if (entry.totpSecrets?.length) {
    stats.withTotp++;
    stats.totalTotp += entry.totpSecrets.length;
  }
  if (entry.customFields?.length) {
    stats.withCustomFields++;
    stats.totalCustomFields += entry.customFields.length;
  }
  if (entry.tags?.length) {
    stats.withTags++;
    entry.tags.forEach((t) => stats.tagCounts.set(t, (stats.tagCounts.get(t) ?? 0) + 1));
  }
}

interface CommitStats {
  totalCommits: number;
  maxCommits: number;
  neverEdited: number;
}

function accumulateCommitStats(stats: CommitStats, entry: Entry): void {
  const commitCount = entry.history?.length ?? 1;
  stats.totalCommits += commitCount;
  if (commitCount > stats.maxCommits) stats.maxCommits = commitCount;
  if (commitCount === 1) stats.neverEdited++;
}

interface EntryListStat {
  bytes: number;
  title: string | null;
  username: string | null;
}

type EntryStats = FieldCoverageStats &
  CommitStats & {
    totalBytes: number;
    entryList: EntryListStat[];
  };

function accumulateOneEntry(stats: EntryStats, entry: Entry): void {
  const entryBytes = new TextEncoder().encode(JSON.stringify(entry)).length;
  stats.totalBytes += entryBytes;
  accumulateFieldCoverage(stats, entry);
  accumulateCommitStats(stats, entry);
  stats.entryList.push({ bytes: entryBytes, title: entry.title || null, username: entry.username || null });
}

function accumulateEntryStats(entries: Entry[]): EntryStats {
  const stats: EntryStats = {
    totalBytes: 0,
    withPassword: 0,
    withUsername: 0,
    withNotes: 0,
    withUrls: 0,
    totalUrls: 0,
    withTotp: 0,
    totalTotp: 0,
    withCustomFields: 0,
    totalCustomFields: 0,
    withTags: 0,
    totalCommits: 0,
    maxCommits: 0,
    neverEdited: 0,
    tagCounts: new Map(),
    entryList: [],
  };
  for (const entry of entries) accumulateOneEntry(stats, entry);
  stats.entryList.sort((a, b) => b.bytes - a.bytes);
  return stats;
}

function topTagsFrom(tagCounts: Map<string, number>): { tag: string; count: number }[] {
  return [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag, count]) => ({ tag, count }));
}

function buildAboutStats(entries: Entry[], trash: Entry[]) {
  const vaultStats = getVaultStats(entries, trash);
  const { totalBytes, totalCommits, tagCounts, entryList, ...counts } = accumulateEntryStats(entries);
  const count = vaultStats.entryCount;
  return {
    count,
    trashCount: vaultStats.trashCount,
    entriesJsonSize: totalBytes,
    avgBytes: count ? Math.round(totalBytes / count) : 0,
    ...counts,
    avgCommits: count ? (totalCommits / count).toFixed(1) : '—',
    topTags: topTagsFrom(tagCounts),
    top5: entryList.slice(0, 5),
  };
}

type AboutStats = ReturnType<typeof buildAboutStats>;

function AboutPage() {
  const [stats, setStats] = useState<AboutStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const { entries, trash } = await fetchUserEntries();
        setStats(buildAboutStats(entries, trash));
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

          {stats.count > 0 && (
            <>
              <StatsHeading>Field coverage</StatsHeading>
              <StatsTable
                rows={[
                  { label: 'Password', value: `${stats.withPassword} / ${stats.count}` },
                  { label: 'Username', value: `${stats.withUsername} / ${stats.count}` },
                  { label: 'Notes', value: `${stats.withNotes} / ${stats.count}` },
                  {
                    label: 'URLs',
                    value: `${stats.withUrls} / ${stats.count}`,
                    note: stats.totalUrls > 0 ? `${stats.totalUrls} total` : null,
                  },
                  {
                    label: 'TOTP secrets',
                    value: `${stats.withTotp} / ${stats.count}`,
                    note: stats.totalTotp > 0 ? `${stats.totalTotp} total` : null,
                  },
                  {
                    label: 'Custom fields',
                    value: `${stats.withCustomFields} / ${stats.count}`,
                    note: stats.totalCustomFields > 0 ? `${stats.totalCustomFields} total` : null,
                  },
                  { label: 'Tags', value: `${stats.withTags} / ${stats.count}` },
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

              {stats.topTags.length > 0 && (
                <>
                  <StatsHeading>Top tags</StatsHeading>
                  <div className="mb-3">
                    {stats.topTags.map(({ tag, count }) => (
                      <span key={tag} className="badge bg-secondary me-1 mb-1">
                        {tag} <span className="opacity-75">({count})</span>
                      </span>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {stats.top5.length > 0 && (
            <>
              <StatsHeading>Top {stats.top5.length} largest entries</StatsHeading>
              <table className="table table-sm" style={{ tableLayout: 'fixed', width: '100%' }}>
                <thead>
                  <tr>
                    <th className="text-muted fw-normal" style={{ width: '30%' }}>
                      Title
                    </th>
                    <th className="text-muted fw-normal" style={{ width: '30%' }}>
                      Username
                    </th>
                    <th className="text-muted fw-normal">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.top5.map((e, i) => (
                    <tr key={i}>
                      <td className="fw-semibold text-truncate">
                        {e.title ?? <span className="text-muted fst-italic">—</span>}
                      </td>
                      <td className="text-muted small text-truncate">
                        {e.username || <span className="fst-italic">—</span>}
                      </td>
                      <td className="fw-semibold">{e.bytes.toLocaleString()} B</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
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
  const [backupResults, setBackupResults] = useState<UploadResult[] | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const { entries, trash } = await fetchUserEntries();
      const exportObj = buildExportData({ username: getUsername(), entries, trash });
      downloadJsonFile(exportObj, `secbits-export-${new Date().toISOString().slice(0, 10)}.json`);
    } catch {
      alert('Failed to export data.');
    } finally {
      setExporting(false);
    }
  }, []);

  const destinations = getBackupDestinations();
  const hasCloudDestinations = Boolean(destinations.r2_config) || destinations.s3_config.length > 0;
  const backupMasterKeyBytes = getBackupMasterKeyBytes();

  const handleCloudBackup = useCallback(async () => {
    setBackingUp(true);
    setBackupResults(null);
    setBackupError(null);
    try {
      const { entries, trash } = await fetchUserEntries();
      const exportObj = buildExportData({ username: getUsername(), entries, trash });
      const blob = await buildCloudBackupBlob(exportObj, backupMasterKeyBytes!);
      const key = `secbits-backup-${new Date().toISOString().slice(0, 10)}.bin`;
      const results = await uploadAllBackupDestinations(destinations, blob, key);
      setBackupResults(results);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : 'Failed to back up to cloud.');
    } finally {
      setBackingUp(false);
    }
  }, [destinations, backupMasterKeyBytes]);

  return (
    <div className="p-4" style={{ maxWidth: 700 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-download me-2"></i>Export
      </h5>
      <div className="fw-semibold mb-1">Local export</div>
      <div className="text-muted small mb-2">
        Download every entry as a plain, unencrypted JSON file. No encryption is involved; this file is a full decrypted
        copy of your vault.
      </div>
      <SpinnerBtn
        className="btn btn-primary btn-sm"
        onClick={handleExport}
        busy={exporting}
        busyLabel="Exporting..."
        icon="bi-download"
      >
        Export all data
      </SpinnerBtn>

      <div className="fw-semibold mb-1 mt-4">Cloud backup</div>
      <div className="text-muted small mb-2">
        Compress and encrypt the same vault content under a dedicated backup key, then upload it to Cloudflare R2 and
        every configured S3 compatible destination. Each destination is uploaded independently.
      </div>
      {!hasCloudDestinations ? (
        <div className="text-muted small fst-italic">
          No cloud backup destinations configured; nothing to back up to.
        </div>
      ) : !backupMasterKeyBytes ? (
        <div className="text-muted small fst-italic">
          Cloud backup destinations are configured, but no backup master key is set; add one to your config file to
          enable cloud backup.
        </div>
      ) : (
        <SpinnerBtn
          className="btn btn-outline-primary btn-sm"
          onClick={handleCloudBackup}
          busy={backingUp}
          busyLabel="Backing up..."
          icon="bi-cloud-upload"
        >
          Back up to cloud
        </SpinnerBtn>
      )}
      {backupError && <div className="alert alert-danger small py-2 mt-2 mb-0">{backupError}</div>}
      {backupResults && (
        <ul className="list-unstyled small mt-2 mb-0">
          {backupResults.map((r) => (
            <li key={r.destination} className={r.ok ? 'text-success' : 'text-danger'}>
              <i className={`bi ${r.ok ? 'bi-check-circle' : 'bi-x-circle'} me-1`}></i>
              {r.destination}
              {r.ok ? ' uploaded' : `: ${r.error}`}
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

type SettingsPage = 'export' | 'security' | 'about' | undefined;

function SettingsPanel({ page }: { page: SettingsPage }) {
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
