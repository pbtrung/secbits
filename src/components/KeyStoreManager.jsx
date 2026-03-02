import { useCallback, useEffect, useMemo, useState } from 'react';
import SpinnerBtn from './SpinnerBtn';
import { addEmergencyKey, listKeyStore, regenerateOwnKeyPair } from '../lib/api';

function byType(keys) {
  const groups = new Map();
  for (const key of keys) {
    if (!groups.has(key.type)) groups.set(key.type, []);
    groups.get(key.type).push(key);
  }
  return groups;
}

function KeyStoreManager() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addingEmergency, setAddingEmergency] = useState(false);
  const [rotatingPair, setRotatingPair] = useState(false);
  const [label, setLabel] = useState('');
  const [status, setStatus] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listKeyStore();
      setKeys(data);
    } catch (err) {
      setStatus({ type: 'danger', msg: err?.message || 'Failed to load key store.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const grouped = useMemo(() => byType(keys), [keys]);

  const handleAddEmergency = useCallback(async () => {
    setAddingEmergency(true);
    setStatus(null);
    try {
      await addEmergencyKey(label.trim() || null);
      setLabel('');
      setStatus({ type: 'success', msg: 'Emergency key added.' });
      await reload();
    } catch (err) {
      setStatus({ type: 'danger', msg: err?.message || 'Failed to add emergency key.' });
    } finally {
      setAddingEmergency(false);
    }
  }, [label, reload]);

  const handleRegeneratePair = useCallback(async () => {
    setRotatingPair(true);
    setStatus(null);
    try {
      await regenerateOwnKeyPair();
      setStatus({ type: 'success', msg: 'Asymmetric key pair regenerated.' });
      await reload();
    } catch (err) {
      setStatus({ type: 'danger', msg: err?.message || 'Failed to regenerate key pair.' });
    } finally {
      setRotatingPair(false);
    }
  }, [reload]);

  return (
    <div className="card mb-3">
      <div className="card-body">
        <h6 className="fw-bold mb-3">
          <i className="bi bi-key me-2"></i>Key Store
        </h6>

        <div className="row g-2 mb-3">
          <div className="col-sm-8">
            <input
              className="form-control form-control-sm"
              placeholder="Emergency key label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={120}
              disabled={addingEmergency || rotatingPair}
            />
          </div>
          <div className="col-sm-4 d-grid">
            <SpinnerBtn
              className="btn btn-outline-primary btn-sm"
              onClick={handleAddEmergency}
              busy={addingEmergency}
              disabled={rotatingPair}
              busyLabel="Adding..."
            >
              Add emergency key
            </SpinnerBtn>
          </div>
          <div className="col-12">
            <SpinnerBtn
              className="btn btn-outline-secondary btn-sm"
              onClick={handleRegeneratePair}
              busy={rotatingPair}
              disabled={addingEmergency}
              busyLabel="Regenerating..."
            >
              Regenerate own public/private key pair
            </SpinnerBtn>
          </div>
        </div>

        {status && <div className={`alert alert-${status.type} small py-2`}>{status.msg}</div>}

        {loading ? (
          <div className="text-muted small">
            <span className="spinner-border spinner-border-sm me-2"></span>Loading keys...
          </div>
        ) : (
          <div className="table-responsive">
            <table className="table table-sm mb-0">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Count</th>
                  <th>Latest label</th>
                  <th>Latest created</th>
                </tr>
              </thead>
              <tbody>
                {['umk', 'emergency', 'own_public', 'own_private', 'peer_public'].map((type) => {
                  const rows = grouped.get(type) || [];
                  const latest = rows[0] || null;
                  return (
                    <tr key={type}>
                      <td><code>{type}</code></td>
                      <td>{rows.length}</td>
                      <td>{latest?.label || <span className="text-muted">—</span>}</td>
                      <td className="small text-muted">{latest?.created_at || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default KeyStoreManager;
