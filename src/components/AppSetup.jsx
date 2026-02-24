import { useState, useRef } from 'react';
import { initApi, fetchUser, saveUserMasterKey, setUserMasterKey, clearUserMasterKey } from '../api';
import { decodeRootMasterKey, setupUserMasterKey, verifyUserMasterKey } from '../crypto';

function AppSetup({ onReady }) {
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef();

  const validate = (config) => {
    if (!config.worker_url) return 'Missing required field: worker_url';
    return null;
  };

  const processConfigText = async (text) => {
    clearUserMasterKey();
    const json = JSON.parse(text);
    const err = validate(json);
    if (err) throw new Error(err);

    if (!json.email) throw new Error('Missing required field: email');
    if (!json.password) throw new Error('Missing required field: password');
    if (!json.firebase_api_key) throw new Error('Missing required field: firebase_api_key');
    if (!json.firebase_project_id) throw new Error('Missing required field: firebase_project_id');
    if (!json.root_master_key) throw new Error('Missing required field: root_master_key');

    const rootMasterKeyBytes = decodeRootMasterKey(json.root_master_key);

    setStatus('Authenticating...');
    const { userId } = await initApi(json);

    setStatus('Fetching user...');
    const userData = await fetchUser();
    if (!userData) throw new Error('User not found');
    const username = userData.username || json.username || '';
    if (!username) throw new Error('Username is empty');

    const storedUserMasterKey = userData.user_master_key;
    let userMasterKey;
    if (!storedUserMasterKey) {
      setStatus('Setting up encryption...');
      const { userMasterKeyBlob, userMasterKey: generated } = await setupUserMasterKey(rootMasterKeyBytes);
      await saveUserMasterKey(userMasterKeyBlob, username);
      userMasterKey = generated;
    } else {
      setStatus('Verifying master key...');
      userMasterKey = await verifyUserMasterKey(rootMasterKeyBytes, storedUserMasterKey);
      if (!userData.username && json.username) {
        await saveUserMasterKey(storedUserMasterKey, username);
      }
    }

    setUserMasterKey(userMasterKey);
    userMasterKey.fill(0);

    return { userId, username };
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
        clearUserMasterKey();
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
    <div className="vh-100 d-flex align-items-center justify-content-center bg-dark">
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
  "username": "<username>",
  "worker_url": "https://<worker>.<account>.workers.dev",
  "email": "user@example.com",
  "password": "xxx",
  "firebase_api_key": "<firebase-web-api-key>",
  "firebase_project_id": "<firebase-project-id>",
  "root_master_key": "<base64, >=256 bytes>"
}`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AppSetup;
