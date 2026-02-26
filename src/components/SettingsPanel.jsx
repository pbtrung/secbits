import { useState } from 'react';
import { decodeRootMasterKey } from '../crypto';
import { getVaultStats, rotateRootMasterKey } from '../api';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value % 1 === 0 ? value : value.toFixed(2)} ${units[i]}`;
}

function SecurityPage() {
  const [nextKeyB64, setNextKeyB64] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const canSubmit = nextKeyB64.trim().length > 0 && confirm && !busy;

  const handleRotate = async () => {
    setStatus('');
    try {
      const keyBytes = decodeRootMasterKey(nextKeyB64.trim());
      setBusy(true);
      await rotateRootMasterKey(keyBytes);
      setStatus('Root master key rotated. Update your config JSON to use the new key.');
      setConfirm(false);
      setNextKeyB64('');
    } catch (err) {
      setStatus(err?.message || 'Failed to rotate root master key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4" style={{ maxWidth: 760 }}>
      <h5 className="fw-bold mb-3">
        <i className="bi bi-shield-lock me-2"></i>Security
      </h5>
      <p className="text-muted small">
        This rotates the root master key by re-encrypting the current vault blob before writing back to R2.
      </p>

      <label className="form-label small text-muted">New `root_master_key` (base64, decoded length &gt;= 256 bytes)</label>
      <textarea
        className="form-control font-monospace"
        rows={4}
        value={nextKeyB64}
        onChange={(e) => setNextKeyB64(e.target.value)}
        placeholder="Paste new base64 key"
      />

      <div className="form-check mt-3">
        <input
          id="confirmRotate"
          className="form-check-input"
          type="checkbox"
          checked={confirm}
          onChange={(e) => setConfirm(e.target.checked)}
        />
        <label htmlFor="confirmRotate" className="form-check-label small">
          I already updated my secure config backup with this new key.
        </label>
      </div>

      <div className="mt-3 d-flex gap-2 align-items-center">
        <button className="btn btn-primary" disabled={!canSubmit} onClick={handleRotate}>
          {busy ? 'Rotating...' : 'Rotate Root Key'}
        </button>
      </div>

      {status && (
        <div className={`alert mt-3 mb-0 ${status.includes('failed') || status.includes('Failed') ? 'alert-danger' : 'alert-info'}`}>
          {status}
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
  if (page === 'about') return <AboutPage />;
  return <SecurityPage />;
}

export default SettingsPanel;
