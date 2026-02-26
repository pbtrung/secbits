import { useState, useEffect, useCallback } from 'react';
import { bytesToB64, decodeRootMasterKey } from '../crypto';
import { buildExportData, fetchUserEntries, getUsername, getVaultStats, rotateRootMasterKey } from '../api';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value % 1 === 0 ? value : value.toFixed(2)} ${units[i]}`;
}

function ExportPage() {
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const { entries } = await fetchUserEntries();
      const exportObj = buildExportData({ username: getUsername(), entries });
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

  return (
    <div className="p-4" style={{ maxWidth: 700 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-download me-2"></i>Export
      </h5>
      <div className="fw-semibold mb-1">Export</div>
      <div className="text-muted small mb-2">
        Export all entries as a decrypted JSON file for local backup or migration.
      </div>
      <button
        className="btn btn-primary btn-sm"
        onClick={handleExport}
        disabled={exporting}
      >
        {exporting ? (
          <><span className="spinner-border spinner-border-sm me-1"></span>Exporting...</>
        ) : (
          <><i className="bi bi-download me-1"></i>Export all data</>
        )}
      </button>
    </div>
  );
}

function SecurityPage() {
  const [newKeyB64, setNewKeyB64] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);
  const [copied, setCopied] = useState(false);

  const generateKey = useCallback(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(256));
    setNewKeyB64(bytesToB64(bytes));
    setConfirmed(false);
    setStatus(null);
    setCopied(false);
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

  const handleChange = async () => {
    if (!confirmed || loading) return;
    setLoading(true);
    setStatus(null);
    try {
      const newKeyBytes = decodeRootMasterKey(newKeyB64);
      await rotateRootMasterKey(newKeyBytes);
      setStatus({ type: 'success', msg: 'Root master key changed successfully. Update your config JSON with the new key.' });
    } catch (err) {
      setStatus({ type: 'error', msg: err?.message || 'Failed to change root master key.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4" style={{ maxWidth: 500 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-shield-lock me-2"></i>Security
      </h5>

      <div className="fw-semibold mb-1">Change Root Master Key</div>
      <p className="text-muted small mb-1">
        The root master key wraps your session key stored on the server. Rotating it re-encrypts only that blob — your entries are unaffected.
      </p>
      <p className="text-muted small mb-3">
        <strong>Warning: After saving the new key, you must update your config JSON immediately. If you lose the new key, you will be permanently locked out.</strong>
      </p>

      <label className="form-label small fw-semibold mb-1">New root master key</label>
      <textarea
        className="form-control font-monospace mb-1"
        style={{ fontSize: '0.7rem' }}
        rows={6}
        readOnly
        value={newKeyB64}
      />
      <div className="d-flex gap-2 mb-3">
        <button
          className="btn btn-outline-secondary btn-sm"
          onClick={handleCopy}
          disabled={loading}
        >
          <i className={`bi ${copied ? 'bi-check' : 'bi-clipboard'} me-1`}></i>
          {copied ? 'Copied!' : 'Copy'}
        </button>
        <button
          className="btn btn-outline-secondary btn-sm"
          onClick={generateKey}
          disabled={loading}
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
          disabled={loading}
        />
        <label className="form-check-label small" htmlFor="securityConfirmCheck">
          I have copied and saved the new root master key to my config JSON and a secure location.
        </label>
      </div>

      <button
        className="btn btn-danger btn-sm"
        onClick={handleChange}
        disabled={!confirmed || loading}
      >
        {loading ? (
          <><span className="spinner-border spinner-border-sm me-1"></span>Changing...</>
        ) : (
          'Change root master key'
        )}
      </button>

      {status && (
        <div className={`alert alert-${status.type === 'success' ? 'success' : 'danger'} mt-3 small mb-0`}>
          {status.msg}
        </div>
      )}
    </div>
  );
}

function AboutPage() {
  const stats = getVaultStats();

  return (
    <div className="p-4" style={{ maxWidth: 500 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-info-circle me-2"></i>About
      </h5>
      <table className="table table-sm mb-0">
        <tbody>
          <tr>
            <td className="text-muted">Entries</td>
            <td className="fw-semibold">{stats.count}</td>
          </tr>
          <tr>
            <td className="text-muted">Vault JSON size</td>
            <td className="fw-semibold">{formatBytes(stats.totalBytes)}</td>
          </tr>
          <tr>
            <td className="text-muted">Average entry size</td>
            <td className="fw-semibold">{formatBytes(stats.avgBytes)}</td>
          </tr>
        </tbody>
      </table>
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
