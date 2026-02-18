import React, { useState, useEffect, useCallback } from 'react';
import { fetchRawUserDocs, fetchUser, getEntryMasterKey } from '../firebase';
import { unwrapEntryDocKey, decryptEntrySnapshotsWithDocKey, bytesToB64 } from '../crypto';

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

function ExportPage({ userId }) {
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const [docs, userData] = await Promise.all([
        fetchRawUserDocs(userId),
        fetchUser(userId),
      ]);
      const masterKey = getEntryMasterKey();
      const decryptedDocs = [];
      for (const d of docs) {
        const entry = { id: d.id };
        const encKeyBytes = valueToBytes(d.enc_key);
        if (encKeyBytes && masterKey) {
          const docKeyBytes = unwrapEntryDocKey(masterKey, encKeyBytes);
          entry.enc_key = bytesToB64(docKeyBytes);
          if (valueToBytes(d.value)) {
            const snapshots = await decryptEntrySnapshotsWithDocKey(docKeyBytes, d.value);
            entry.value = snapshots.map(({ _snapshots, ...rest }) => rest);
          } else {
            entry.value = d.value;
          }
        } else {
          entry.enc_key = encKeyBytes ? bytesToB64(encKeyBytes) : d.enc_key;
          entry.value = d.value;
        }
        decryptedDocs.push(entry);
      }
      const storedMasterKey = valueToBytes(userData?.master_key);
      const exportData = {
        user_id: userId,
        master_key: masterKey ? bytesToB64(masterKey) : (storedMasterKey ? bytesToB64(storedMasterKey) : null),
        username: userData?.username || null,
        data: decryptedDocs,
      };
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
    fetchRawUserDocs(userId)
      .then((docs) => {
        let totalBytes = 0;
        docs.forEach((doc) => {
          if (doc.value) totalBytes += valueByteLength(doc.value);
          if (doc.enc_key) totalBytes += valueByteLength(doc.enc_key);
        });
        setStats({ count: docs.length, totalBytes });
        setLoading(false);
      })
      .catch(() => {
        setStats(null);
        setLoading(false);
      });
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
          <table className="table table-sm">
            <tbody>
              <tr>
                <td className="text-muted">Entries</td>
                <td className="fw-semibold">{stats.count}</td>
              </tr>
              <tr>
                <td className="text-muted">Total stored size</td>
                <td className="fw-semibold">{formatBytes(stats.totalBytes)}</td>
              </tr>
            </tbody>
          </table>
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
