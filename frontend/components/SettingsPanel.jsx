import { useCallback, useEffect, useState } from 'react';
import SpinnerBtn from './SpinnerBtn';
import {
  backupPull,
  backupPush,
  browseExportPath,
  exportVaultToPath,
  generateRootMasterKey,
  getExportPathInfo,
  getVaultStats,
  rotateMasterKey,
  setExportPath,
} from '../api';

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

function StatsTable({ rows, className = 'table table-sm mb-3 settings-stats-table' }) {
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
    let mounted = true;
    (async () => {
      try {
        const value = await getVaultStats();
        if (mounted) setStats(value);
      } catch {
        // stats stays null
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
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
              { label: 'Entries', value: stats.entryCount },
              { label: 'Trash entries', value: stats.trashCount },
            ]}
          />

          {stats.entryCount > 0 && (<>
            <StatsHeading>Entry types</StatsHeading>
            <StatsTable
              rows={[
                { label: 'Logins', value: stats.loginCount },
                { label: 'Notes', value: stats.noteCount },
                { label: 'Cards', value: stats.cardCount },
              ]}
            />

            {stats.withPassword != null && (<>
              <StatsHeading>Field coverage</StatsHeading>
              <StatsTable
                rows={[
                  { label: 'Password', value: `${stats.withPassword} / ${stats.entryCount}` },
                  { label: 'Username', value: `${stats.withUsername} / ${stats.entryCount}` },
                  { label: 'Notes', value: `${stats.withNotes} / ${stats.entryCount}` },
                  { label: 'URLs', value: `${stats.withUrls} / ${stats.entryCount}`, note: stats.totalUrls > 0 ? `${stats.totalUrls} total` : null },
                  { label: 'TOTP secrets', value: `${stats.withTotp} / ${stats.entryCount}`, note: stats.totalTotp > 0 ? `${stats.totalTotp} total` : null },
                  { label: 'Custom fields', value: `${stats.withCustomFields} / ${stats.entryCount}`, note: stats.totalCustomFields > 0 ? `${stats.totalCustomFields} total` : null },
                  { label: 'Tags', value: `${stats.withTags} / ${stats.entryCount}` },
                ]}
              />
            </>)}

            <StatsHeading>Version history</StatsHeading>
            <StatsTable
              rows={[
                { label: 'Avg commits per entry', value: Number(stats.avgCommitsPerEntry).toFixed(1) },
                ...(stats.maxCommits != null ? [
                  { label: 'Max commits on one entry', value: stats.maxCommits },
                  { label: 'Never edited', value: stats.neverEdited },
                ] : []),
              ]}
            />

            {stats.topTags?.length > 0 && (<>
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
        </div>
      ) : (
        <div className="text-danger small">Failed to load stats.</div>
      )}
    </div>
  );
}

function ExportPage() {
  const [exporting, setExporting] = useState(false);
  const [loadingPath, setLoadingPath] = useState(true);
  const [exportPath, setExportPathState] = useState('');
  const [status, setStatus] = useState(null);

  const loadPathInfo = useCallback(async () => {
    setLoadingPath(true);
    try {
      const info = await getExportPathInfo();
      setExportPathState(info?.path || '');
    } catch {
      setExportPathState('');
    } finally {
      setLoadingPath(false);
    }
  }, []);

  useEffect(() => {
    loadPathInfo();
  }, [loadPathInfo]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setStatus(null);
    try {
      const selected = await browseExportPath();
      if (!selected) return;

      await setExportPath(selected);
      const written = await exportVaultToPath(selected);
      setStatus({ type: 'success', msg: `Exported to ${written}` });
      await loadPathInfo();
    } catch (err) {
      setStatus({ type: 'error', msg: err?.message || 'Failed to export vault' });
    } finally {
      setExporting(false);
    }
  }, [loadPathInfo]);

  return (
    <div className="p-4" style={{ maxWidth: 680 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-download me-2"></i>Export
      </h5>
      <p className="text-muted small">
        Export returns fully decrypted JSON. Store it securely.
      </p>
      {loadingPath ? (
        <div className="text-muted small mb-3">
          <span className="spinner-border spinner-border-sm me-2"></span>Loading export path...
        </div>
      ) : exportPath ? (
        <div className="mb-3 small">
          <div className="text-muted mb-1">Default export file path</div>
          <div className="font-monospace">{exportPath}</div>
        </div>
      ) : (
        <div className="text-muted small mb-3">
          No default export file path configured.
        </div>
      )}
      <SpinnerBtn
        className="btn btn-primary btn-sm"
        onClick={handleExport}
        disabled={loadingPath || exporting}
        busy={exporting}
        busyLabel="Exporting..."
        icon="bi-download"
      >
        Export Vault JSON
      </SpinnerBtn>
      {status && (
        <div className={`alert mt-3 mb-0 small ${status.type === 'error' ? 'alert-danger' : 'alert-success'}`}>
          {status.msg}
        </div>
      )}
    </div>
  );
}

function SecurityPage() {
  const [newKeyB64, setNewKeyB64] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState(null);
  const [copied, setCopied] = useState(false);

  const generateKey = useCallback(async () => {
    setGenerating(true);
    setConfirmed(false);
    setStatus(null);
    setCopied(false);
    try {
      const key = await generateRootMasterKey();
      setNewKeyB64(key);
    } catch (err) {
      setStatus({ type: 'error', msg: err?.message || 'Failed to generate key.' });
    } finally {
      setGenerating(false);
    }
  }, []);

  useEffect(() => {
    generateKey();
  }, [generateKey]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(newKeyB64);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  };

  const handleRotate = useCallback(async () => {
    if (!confirmed || rotating) return;
    setRotating(true);
    setStatus(null);
    try {
      await rotateMasterKey(newKeyB64);
      setStatus({ type: 'success', msg: 'Root master key changed successfully. Update your config with the new key.' });
    } catch (err) {
      setStatus({ type: 'error', msg: err?.message || 'Failed to change root master key.' });
    } finally {
      setRotating(false);
    }
  }, [confirmed, rotating, newKeyB64]);

  const busy = rotating || generating;

  return (
    <div className="p-4" style={{ maxWidth: 500 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-shield-lock me-2"></i>Security
      </h5>

      <div className="fw-semibold mb-1">Change Root Master Key</div>
      <p className="text-muted small mb-1">
        The root master key wraps the user master key stored in the vault. Rotating it re-encrypts only that blob — your entries are unaffected.
      </p>
      <p className="text-muted small mb-3">
        <strong>Warning: After saving the new key, you must update your config immediately. If you lose the new key, you will be permanently locked out.</strong>
      </p>

      <label className="form-label small fw-semibold mb-1">New root master key</label>
      <textarea
        className="form-control font-monospace mb-1"
        style={{ fontSize: '0.7rem' }}
        rows={6}
        readOnly
        value={generating ? 'Generating\u2026' : newKeyB64}
      />
      <div className="d-flex gap-2 mb-3">
        <button
          className="btn btn-outline-secondary btn-sm"
          onClick={handleCopy}
          disabled={busy || !newKeyB64}
        >
          <i className={`bi ${copied ? 'bi-check' : 'bi-clipboard'} me-1`}></i>
          {copied ? 'Copied!' : 'Copy'}
        </button>
        <button
          className="btn btn-outline-secondary btn-sm"
          onClick={generateKey}
          disabled={busy}
        >
          <i className="bi bi-arrow-clockwise me-1"></i>Regenerate
        </button>
      </div>

      <div className="form-check mb-3">
        <input
          className="form-check-input"
          type="checkbox"
          id="securityConfirmCheck"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          disabled={busy}
        />
        <label className="form-check-label small" htmlFor="securityConfirmCheck">
          I have copied and saved the new root master key to my config and a secure location.
        </label>
      </div>

      <SpinnerBtn
        className="btn btn-danger btn-sm"
        onClick={handleRotate}
        disabled={!confirmed || !newKeyB64}
        busy={rotating}
        busyLabel="Changing..."
      >Change root master key</SpinnerBtn>

      {status && (
        <div className={`alert alert-${status.type === 'success' ? 'success' : 'danger'} mt-3 small mb-0`}>
          {status.msg}
        </div>
      )}
    </div>
  );
}

function BackupPage() {
  const [target, setTarget] = useState('');
  const [loadingPush, setLoadingPush] = useState(false);
  const [loadingPull, setLoadingPull] = useState(false);
  const [status, setStatus] = useState(null);

  const doPush = useCallback(async () => {
    setStatus(null);
    setLoadingPush(true);
    try {
      await backupPush(target.trim() || undefined);
      setStatus({ type: 'success', msg: 'Backup push completed.' });
    } catch (err) {
      setStatus({ type: 'error', msg: err?.message || 'Backup push failed' });
    } finally {
      setLoadingPush(false);
    }
  }, [target]);

  const doPull = useCallback(async () => {
    if (!target.trim()) {
      setStatus({ type: 'error', msg: 'Backup pull requires a target name.' });
      return;
    }

    if (!window.confirm('Pull backup and replace local DB?')) {
      return;
    }

    setStatus(null);
    setLoadingPull(true);
    try {
      await backupPull(target.trim());
      setStatus({ type: 'success', msg: 'Backup pull completed.' });
    } catch (err) {
      setStatus({ type: 'error', msg: err?.message || 'Backup pull failed' });
    } finally {
      setLoadingPull(false);
    }
  }, [target]);

  return (
    <div className="p-4" style={{ maxWidth: 680 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-cloud-arrow-up me-2"></i>Backups
      </h5>

      <label className="form-label fw-semibold">Target (optional for push, required for pull)</label>
      <input
        className="form-control"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        placeholder="r2"
      />

      <div className="d-flex gap-2 mt-3">
        <SpinnerBtn
          className="btn btn-outline-primary btn-sm"
          onClick={doPush}
          busy={loadingPush}
          busyLabel="Pushing..."
          icon="bi-cloud-upload"
        >
          Backup Push
        </SpinnerBtn>
        <SpinnerBtn
          className="btn btn-outline-warning btn-sm"
          onClick={doPull}
          busy={loadingPull}
          busyLabel="Pulling..."
          icon="bi-cloud-download"
        >
          Backup Pull
        </SpinnerBtn>
      </div>

      {status && (
        <div className={`alert alert-${status.type === 'success' ? 'success' : 'danger'} mt-3 mb-0 small`}>
          {status.msg}
        </div>
      )}
    </div>
  );
}

function SettingsPanel({ page }) {
  if (page === 'export') return <ExportPage />;
  if (page === 'security') return <SecurityPage />;
  if (page === 'backup') return <BackupPage />;
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
