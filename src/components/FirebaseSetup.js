import React, { useState, useRef } from 'react';
import { initFirebase, signIn, fetchUser, saveUserMasterKey, initUserDataCollection } from '../firebase';
import { decodeMasterKey, masterKeySetup, masterKeyVerify } from '../crypto';

const REQUIRED_KEYS = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];

function FirebaseSetup({ onReady }) {
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef();

  const validate = (config) => {
    const missing = REQUIRED_KEYS.filter((k) => !config[k]);
    if (missing.length > 0) {
      return `Missing required fields: ${missing.join(', ')}`;
    }
    return null;
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
      try {
        const json = JSON.parse(e.target.result);
        const config = json.auth || json;
        const err = validate(config);
        if (err) {
          setError(err);
          return;
        }
        const userId = json.user_id;
        if (!userId) {
          setError('Missing required field: user_id');
          return;
        }
        if (!json.master_key) {
          setError('Missing required field: master_key');
          return;
        }
        const dbName = json.db_name || '';

        // Decode and validate master_key (base64, >= 128 bytes)
        let masterKeyBytes;
        try {
          masterKeyBytes = decodeMasterKey(json.master_key);
        } catch (mkErr) {
          setError(mkErr.message);
          return;
        }

        setLoading(true);

        try {
          // Init Firebase and authenticate
          setStatus('Authenticating...');
          initFirebase(config, dbName);
          await signIn();

          // Fetch user document
          setStatus('Fetching user...');
          const userData = await fetchUser(userId);
          if (!userData) {
            setError('User not found');
            setLoading(false);
            return;
          }
          const username = userData.username;
          if (!username) {
            setError('Username is empty');
            setLoading(false);
            return;
          }

          // Master key flow
          const storedMasterKey = userData.master_key;
          if (!storedMasterKey) {
            // First-time setup
            setStatus('Setting up encryption...');
            const { storedValue } = masterKeySetup(masterKeyBytes);
            await saveUserMasterKey(userId, storedValue);
          } else {
            // Returning user — verify
            setStatus('Verifying master key...');
            masterKeyVerify(masterKeyBytes, storedMasterKey);
          }

          // Ensure user data collection exists
          setStatus('Loading data...');
          await initUserDataCollection(userId);

          onReady(userId, username);
        } catch (connErr) {
          setError(connErr.message);
          setLoading(false);
        }
      } catch {
        setError('Invalid JSON file');
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
            <p className="text-muted small">Upload your Firebase configuration to get started</p>
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
  "user_id": "xxx",
  "db_name": "xxx",
  "master_key": "<base64, >=128 bytes>",
  "auth": {
    "apiKey": "",
    "authDomain": "",
    "databaseURL": "",
    "projectId": "",
    "storageBucket": "",
    "messagingSenderId": "",
    "appId": ""
  }
}`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

export default FirebaseSetup;
