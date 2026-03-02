import { useCallback, useEffect, useState } from 'react';
import SpinnerBtn from './SpinnerBtn';
import { bytesToB64, decodeRootMasterKey } from '../lib/crypto';
import { rotateRootMasterKey, rotateUserMasterKey } from '../lib/api';

function KeyRotation() {
  const [newKeyB64, setNewKeyB64] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [loadingUmk, setLoadingUmk] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState(null);

  const generateKey = useCallback(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(256));
    setNewKeyB64(bytesToB64(bytes));
    setConfirmed(false);
    setCopied(false);
  }, []);

  useEffect(() => {
    generateKey();
  }, [generateKey]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(newKeyB64);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // no-op
    }
  };

  const handleRotateRoot = useCallback(async () => {
    if (!confirmed || loadingRoot || loadingUmk) return;
    setLoadingRoot(true);
    setStatus(null);
    try {
      const bytes = decodeRootMasterKey(newKeyB64);
      await rotateRootMasterKey(bytes);
      setStatus({ type: 'success', msg: 'Root master key rotated. Update your config file immediately.' });
    } catch (err) {
      setStatus({ type: 'danger', msg: err?.message || 'Failed to rotate root master key.' });
    } finally {
      setLoadingRoot(false);
    }
  }, [confirmed, loadingRoot, loadingUmk, newKeyB64]);

  const handleRotateUMK = useCallback(async () => {
    if (loadingRoot || loadingUmk) return;
    setLoadingUmk(true);
    setStatus(null);
    try {
      const { rotatedEntries } = await rotateUserMasterKey();
      setStatus({ type: 'success', msg: `User master key rotated and ${rotatedEntries} entry key(s) re-wrapped.` });
    } catch (err) {
      setStatus({ type: 'danger', msg: err?.message || 'Failed to rotate user master key.' });
    } finally {
      setLoadingUmk(false);
    }
  }, [loadingRoot, loadingUmk]);

  return (
    <div className="card mb-3">
      <div className="card-body">
        <h6 className="fw-bold mb-3">
          <i className="bi bi-arrow-repeat me-2"></i>Key Rotation
        </h6>

        <div className="mb-3">
          <label className="form-label small fw-semibold mb-1">New root master key</label>
          <textarea
            className="form-control font-monospace"
            style={{ fontSize: '0.7rem' }}
            rows={4}
            readOnly
            value={newKeyB64}
          />
          <div className="d-flex gap-2 mt-2">
            <button className="btn btn-outline-secondary btn-sm" onClick={handleCopy} disabled={loadingRoot || loadingUmk}>
              <i className={`bi ${copied ? 'bi-check' : 'bi-clipboard'} me-1`}></i>{copied ? 'Copied' : 'Copy'}
            </button>
            <button className="btn btn-outline-secondary btn-sm" onClick={generateKey} disabled={loadingRoot || loadingUmk}>
              <i className="bi bi-arrow-clockwise me-1"></i>Regenerate
            </button>
          </div>
        </div>

        <div className="form-check mb-3">
          <input
            className="form-check-input"
            type="checkbox"
            id="rotateRootConfirm"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            disabled={loadingRoot || loadingUmk}
          />
          <label className="form-check-label small" htmlFor="rotateRootConfirm">
            I saved this root master key securely and updated my config plan.
          </label>
        </div>

        <div className="d-flex flex-wrap gap-2">
          <SpinnerBtn
            className="btn btn-danger btn-sm"
            onClick={handleRotateRoot}
            disabled={!confirmed || loadingUmk}
            busy={loadingRoot}
            busyLabel="Rotating RMK..."
          >
            Rotate root master key
          </SpinnerBtn>
          <SpinnerBtn
            className="btn btn-warning btn-sm"
            onClick={handleRotateUMK}
            disabled={loadingRoot}
            busy={loadingUmk}
            busyLabel="Rotating UMK..."
          >
            Rotate user master key
          </SpinnerBtn>
        </div>

        {status && <div className={`alert alert-${status.type} small py-2 mt-3 mb-0`}>{status.msg}</div>}
      </div>
    </div>
  );
}

export default KeyRotation;
