import { useEffect, useState } from 'react';
import { initVault, isVaultInitialized, unlockVaultSession } from '../api';

function AppSetup({ onReady }) {
  const [initialized, setInitialized] = useState(null);
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const result = await isVaultInitialized();
        if (mounted) {
          setInitialized(result);
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

  const handleUnlock = async () => {
    setError('');
    setSubmitting(true);
    try {
      await unlockVaultSession();
      await onReady('Vault');
    } catch (err) {
      setError(err?.message || 'Failed to unlock vault');
    } finally {
      setSubmitting(false);
    }
  };

  const handleInit = async (event) => {
    event.preventDefault();
    const trimmed = username.trim();
    if (!trimmed) {
      setError('Username is required');
      return;
    }

    setError('');
    setSubmitting(true);
    try {
      await initVault(trimmed);
      await unlockVaultSession();
      await onReady(trimmed);
    } catch (err) {
      setError(err?.message || 'Failed to initialize vault');
    } finally {
      setSubmitting(false);
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
            <p className="text-muted small mb-0">
              {initialized ? 'Unlock your local vault' : 'Create your first local vault'}
            </p>
          </div>

          {initialized ? (
            <div className="d-grid gap-2">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleUnlock}
                disabled={submitting}
              >
                {submitting ? (
                  <><span className="spinner-border spinner-border-sm me-2"></span>Unlocking...</>
                ) : (
                  <><i className="bi bi-unlock me-2"></i>Unlock Vault</>
                )}
              </button>
              <div className="text-muted small">
                Root key and DB path are loaded from your SecBits config file.
              </div>
            </div>
          ) : (
            <form onSubmit={handleInit}>
              <label className="form-label fw-semibold">Username</label>
              <input
                className="form-control mb-3"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                maxLength={64}
                placeholder="alice"
                disabled={submitting}
              />
              <button type="submit" className="btn btn-primary w-100" disabled={submitting}>
                {submitting ? (
                  <><span className="spinner-border spinner-border-sm me-2"></span>Creating...</>
                ) : (
                  <><i className="bi bi-person-plus me-2"></i>Initialize Vault</>
                )}
              </button>
            </form>
          )}

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
