import { useState, useRef } from 'react';
import { initDb, signIn, ensureKeyStore, setUsername, setBackupDestinations, getUserId, clearSession } from '../db';
import { decodeRootMasterKey } from '../crypto';
import { validateConfig } from '../lib/validation';

function AppSetup({ onReady }) {
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef();

  const processConfigText = async (text) => {
    clearSession();
    const json = JSON.parse(text);

    const errors = validateConfig(json);
    if (errors.length > 0) throw new Error(errors.join('; '));

    const rootMasterKeyBytes = decodeRootMasterKey(json.root_master_key);

    initDb(json.instant_app_id);

    setStatus('Authenticating...');
    await signIn({
      email: json.email,
      password: json.password,
      firebaseApiKey: json.firebase_api_key,
      instantClientName: json.instant_client_name,
    });

    setStatus('Unlocking vault...');
    await ensureKeyStore(rootMasterKeyBytes);

    setUsername(json.username);
    setBackupDestinations({ r2_config: json.r2_config, s3_config: json.s3_config });
    const userId = await getUserId();
    return { userId, username: json.username };
  };

  const processFile = (file) => {
    setError(null);
    if (!file) return;
    if (!file.name.endsWith('.json')) {
      setError('Please upload a .json file');
      return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target.result;
      setLoading(true);
      try {
        const { userId, username } = await processConfigText(text);
        setStatus('Loading entries...');
        await onReady(userId, username);
      } catch (connErr) {
        clearSession();
        setError(connErr.message || 'Invalid configuration');
        setLoading(false);
      }
    };
    reader.readAsText(file);
  };

  const handleFileChange = (e) => {
    processFile(e.target.files[0]);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    processFile(e.dataTransfer.files[0]);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  return (
    <div className="min-vh-100 d-flex align-items-center justify-content-center bg-dark px-3 py-4">
      <div className="card shadow" style={{ maxWidth: 500, width: '100%' }}>
        <div className="card-body p-4">
          <div className="text-center mb-4">
            <i className="bi bi-shield-lock fs-1 text-primary"></i>
            <h3 className="fw-bold mt-2">SecBits</h3>
            <p className="text-muted small">Upload your configuration to get started</p>
          </div>

          {loading ? (
            <div className="text-center py-4">
              <div className="spinner-border text-primary mb-3" role="status"></div>
              <p className="text-muted small mb-0">{status}</p>
            </div>
          ) : (
            <div
              className={`border border-2 rounded-3 p-4 text-center ${dragOver ? 'border-primary bg-primary bg-opacity-10' : 'border-dashed'}`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              style={{ cursor: 'pointer', borderStyle: dragOver ? 'solid' : 'dashed' }}
              onClick={() => fileRef.current.click()}
            >
              <i className={`bi ${dragOver ? 'bi-cloud-arrow-down' : 'bi-file-earmark-arrow-up'} fs-2 ${dragOver ? 'text-primary' : 'text-muted'}`}></i>
              <p className="mb-1 mt-2">
                {dragOver ? 'Drop here' : 'Drag & drop your config JSON'}
              </p>
              <p className="text-muted small mb-0">or click to browse</p>
              <input
                ref={fileRef}
                type="file"
                accept=".json"
                className="d-none"
                onChange={handleFileChange}
              />
            </div>
          )}

          {error && (
            <div className="alert alert-danger mt-3 mb-0 small">
              <i className="bi bi-exclamation-triangle me-1"></i>
              {error}
            </div>
          )}

          <div className="mt-4">
            <p className="text-muted small mb-2">Expected JSON format:</p>
            <pre className="bg-light rounded p-2 small mb-0" style={{ fontSize: '0.75rem' }}>
{`{
  "instant_app_id": "<instantdb-app-id>",
  "instant_client_name": "<instantdb-client-name>",
  "firebase_api_key": "<firebase-web-api-key>",
  "email": "<email>",
  "password": "<password>",
  "username": "<display-name>",
  "root_master_key": "<base64, >=256 bytes>",
  "r2_config": { "...": "optional, see README" },
  "s3_config": [{ "...": "optional, see README" }]
}`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AppSetup;
