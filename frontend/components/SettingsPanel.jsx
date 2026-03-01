import { useCallback, useEffect, useState } from 'react';
import SpinnerBtn from './SpinnerBtn';
import { backupPull, backupPush, exportVault, getVaultStats, rotateMasterKey } from '../api';

function AboutPage() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const value = await getVaultStats();
        if (mounted) setStats(value);
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className="p-4" style={{ maxWidth: 680 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-info-circle me-2"></i>About
      </h5>

      {loading ? (
        <div className="text-muted small">Loading stats...</div>
      ) : !stats ? (
        <div className="text-danger small">Failed to load stats.</div>
      ) : (
        <table className="table table-sm">
          <tbody>
            <tr><td className="text-muted">Entries</td><td className="fw-semibold">{stats.entryCount}</td></tr>
            <tr><td className="text-muted">Trash</td><td className="fw-semibold">{stats.trashCount}</td></tr>
            <tr><td className="text-muted">Logins</td><td className="fw-semibold">{stats.loginCount}</td></tr>
            <tr><td className="text-muted">Notes</td><td className="fw-semibold">{stats.noteCount}</td></tr>
            <tr><td className="text-muted">Cards</td><td className="fw-semibold">{stats.cardCount}</td></tr>
            <tr><td className="text-muted">Total commits</td><td className="fw-semibold">{stats.totalCommits}</td></tr>
            <tr><td className="text-muted">Avg commits / entry</td><td className="fw-semibold">{stats.avgCommitsPerEntry.toFixed(2)}</td></tr>
          </tbody>
        </table>
      )}

      {!!stats?.topTags?.length && (
        <div className="mt-3">
          <div className="text-muted small fw-semibold mb-2">Top tags</div>
          {stats.topTags.map(({ tag, count }) => (
            <span key={tag} className="badge bg-secondary me-2 mb-2">
              {tag} ({count})
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ExportPage() {
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const json = await exportVault();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `secbits-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.alert('Failed to export vault');
    } finally {
      setExporting(false);
    }
  }, []);

  return (
    <div className="p-4" style={{ maxWidth: 680 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-download me-2"></i>Export
      </h5>
      <p className="text-muted small">
        Export returns fully decrypted JSON. Store it securely.
      </p>
      <SpinnerBtn
        className="btn btn-primary btn-sm"
        onClick={handleExport}
        busy={exporting}
        busyLabel="Exporting..."
        icon="bi-download"
      >
        Export Vault JSON
      </SpinnerBtn>
    </div>
  );
}

function SecurityPage() {
  const [newKeyB64, setNewKeyB64] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);

  const handleRotate = useCallback(async () => {
    if (!confirmed || loading) return;

    setLoading(true);
    setStatus(null);
    try {
      await rotateMasterKey(newKeyB64.trim());
      setStatus({ type: 'success', msg: 'Root key rotated successfully.' });
    } catch (err) {
      setStatus({ type: 'error', msg: err?.message || 'Failed to rotate key' });
    } finally {
      setLoading(false);
    }
  }, [confirmed, loading, newKeyB64]);

  return (
    <div className="p-4" style={{ maxWidth: 680 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-shield-lock me-2"></i>Security
      </h5>

      <label className="form-label fw-semibold">New root master key (base64)</label>
      <textarea
        className="form-control font-monospace"
        rows={6}
        value={newKeyB64}
        onChange={(e) => setNewKeyB64(e.target.value)}
      />

      <div className="form-check mt-3">
        <input
          className="form-check-input"
          type="checkbox"
          id="rotate-confirm"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <label className="form-check-label small" htmlFor="rotate-confirm">
          I saved this new key in my SecBits config.
        </label>
      </div>

      <SpinnerBtn
        className="btn btn-danger btn-sm mt-3"
        onClick={handleRotate}
        disabled={!confirmed || !newKeyB64.trim()}
        busy={loading}
        busyLabel="Rotating..."
      >
        Rotate Root Key
      </SpinnerBtn>

      {status && (
        <div className={`alert alert-${status.type === 'success' ? 'success' : 'danger'} mt-3 mb-0 small`}>
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
