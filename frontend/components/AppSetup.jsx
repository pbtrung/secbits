import { useEffect, useState } from 'react';
import { browseConfigPath, getSetupInfo, isVaultInitialized, selectConfigPath, unlockVaultSession } from '../api';

function AppSetup({ onReady }) {
  const [configPath, setConfigPath] = useState('');
  const [defaultPath, setDefaultPath] = useState('');
  const [defaultExists, setDefaultExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const setup = await getSetupInfo();
        const remembered = localStorage.getItem('secbits.configPath') || '';
        const initialPath = remembered || (setup.defaultConfigExists ? setup.defaultConfigPath : '');
        if (mounted) {
          setConfigPath(initialPath);
          setDefaultPath(setup.defaultConfigPath || '');
          setDefaultExists(Boolean(setup.defaultConfigExists));
          setLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setError(err?.message || 'Failed to inspect vault state');
          setLoading(false);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const handleOpenVault = async (event) => {
    event.preventDefault();
    const trimmed = configPath.trim();
    if (!trimmed) {
      setError('Config path is required');
      return;
    }

    setError('');
    setSubmitting(true);
    try {
      await selectConfigPath(trimmed);
      const initialized = await isVaultInitialized();
      if (!initialized) {
        throw new Error('Vault is not initialized for this config path.');
      }
      await unlockVaultSession();
      localStorage.setItem('secbits.configPath', trimmed);
      await onReady('Vault');
    } catch (err) {
      setError(err?.message || 'Failed to open vault');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBrowse = async () => {
    try {
      const selected = await browseConfigPath();
      if (selected) {
        setConfigPath(selected);
        setError('');
      }
    } catch (err) {
      setError(err?.message || 'Failed to open file picker');
    }
  };

  if (loading) {
    return (
      <div className="min-vh-100 d-flex align-items-center justify-content-center bg-dark text-light">
        <div className="text-center">
          <div className="spinner-border text-primary" role="status"></div>
          <div className="mt-3 small">Loading vault status...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-vh-100 d-flex align-items-center justify-content-center bg-dark px-3 py-4">
      <div className="card shadow" style={{ maxWidth: 520, width: '100%' }}>
        <div className="card-body p-4">
          <div className="text-center mb-4">
            <i className="bi bi-shield-lock fs-1 text-primary"></i>
            <h3 className="fw-bold mt-2">SecBits</h3>
            <p className="text-muted small mb-0">Open your local vault</p>
          </div>

          <form onSubmit={handleOpenVault}>
            <label className="form-label fw-semibold">Config path</label>
            <div className="input-group mb-2">
              <input
                className="form-control"
                value={configPath}
                onChange={(e) => setConfigPath(e.target.value)}
                placeholder={defaultPath || '/home/user/.config/secbits/config.toml'}
                disabled={submitting}
                autoFocus
              />
              <button
                type="button"
                className="btn btn-outline-secondary"
                onClick={handleBrowse}
                disabled={submitting}
              >
                <i className="bi bi-folder2-open me-1"></i>Select file
              </button>
            </div>
            {defaultExists && (
              <div className="text-muted small mb-3">
                Default config found: <span className="font-monospace">{defaultPath}</span>
              </div>
            )}
            {!defaultExists && defaultPath && (
              <div className="text-muted small mb-3">
                Default config not found at <span className="font-monospace">{defaultPath}</span>
              </div>
            )}
            <button type="submit" className="btn btn-primary w-100" disabled={submitting}>
              {submitting ? (
                <><span className="spinner-border spinner-border-sm me-2"></span>Opening...</>
              ) : (
                <><i className="bi bi-unlock me-2"></i>Open Vault</>
              )}
            </button>
          </form>

          {error && (
            <div className="alert alert-danger mt-3 mb-0 small">
              <i className="bi bi-exclamation-triangle me-1"></i>
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AppSetup;
