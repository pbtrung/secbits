import React, { useState, useRef } from 'react';

const REQUIRED_KEYS = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];

function FirebaseSetup({ onConfigLoaded }) {
  const [error, setError] = useState(null);
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
    reader.onload = (e) => {
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
        const dbName = json.db_name || '';
        onConfigLoaded(config, userId, dbName);
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
