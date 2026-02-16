import React, { useState, useEffect } from 'react';

function EntryDetail({ entry, isEditing, onEdit, onSave, onDelete, onCancel }) {
  const [draft, setDraft] = useState(entry);
  const [visiblePasswords, setVisiblePasswords] = useState({});
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    setDraft(entry);
    setVisiblePasswords({});
  }, [entry]);

  useEffect(() => {
    if (isEditing) setDraft(entry);
  }, [isEditing, entry]);

  const toggleVisibility = (key) => {
    setVisiblePasswords((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  const updateDraft = (field, value) => {
    setDraft({ ...draft, [field]: value });
  };

  const updateUrl = (index, value) => {
    const urls = [...draft.urls];
    urls[index] = value;
    setDraft({ ...draft, urls });
  };

  const addUrl = () => setDraft({ ...draft, urls: [...draft.urls, ''] });

  const removeUrl = (index) => {
    const urls = draft.urls.filter((_, i) => i !== index);
    setDraft({ ...draft, urls });
  };

  const addHiddenField = () => {
    const maxId = draft.hiddenFields.reduce((max, f) => Math.max(max, f.id), 0);
    setDraft({
      ...draft,
      hiddenFields: [...draft.hiddenFields, { id: maxId + 1, label: '', value: '' }],
    });
  };

  const updateHiddenField = (id, key, value) => {
    setDraft({
      ...draft,
      hiddenFields: draft.hiddenFields.map((f) =>
        f.id === id ? { ...f, [key]: value } : f
      ),
    });
  };

  const removeHiddenField = (id) => {
    setDraft({
      ...draft,
      hiddenFields: draft.hiddenFields.filter((f) => f.id !== id),
    });
  };

  const updateTags = (value) => {
    const tags = value
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    setDraft({ ...draft, tags });
  };

  const handleSave = () => {
    onSave(draft);
  };

  const handleDelete = () => {
    if (window.confirm(`Delete "${entry.title || 'this entry'}"?`)) {
      onDelete(entry.id);
    }
  };

  const data = isEditing ? draft : entry;

  const CopyBtn = ({ text, label }) => (
    <button
      className="btn btn-sm btn-outline-secondary"
      onClick={() => copyToClipboard(text, label)}
      title="Copy"
    >
      <i className={`bi ${copied === label ? 'bi-check-lg text-success' : 'bi-clipboard'}`}></i>
    </button>
  );

  return (
    <div className="p-4" style={{ maxWidth: 700 }}>
      {/* Title */}
      <div className="d-flex justify-content-between align-items-start mb-4">
        {isEditing ? (
          <input
            className="form-control form-control-lg fw-bold"
            value={draft.title}
            onChange={(e) => updateDraft('title', e.target.value)}
            placeholder="Entry Title"
            autoFocus
          />
        ) : (
          <h3 className="fw-bold mb-0">{entry.title}</h3>
        )}
      </div>

      {/* Username */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-person me-1"></i> Username
        </label>
        {isEditing ? (
          <input
            className="form-control"
            value={draft.username}
            onChange={(e) => updateDraft('username', e.target.value)}
          />
        ) : (
          <div className="input-group">
            <input className="form-control" value={entry.username} readOnly />
            <CopyBtn text={entry.username} label="username" />
          </div>
        )}
      </div>

      {/* Password */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-lock me-1"></i> Password
        </label>
        {isEditing ? (
          <div className="input-group">
            <input
              type={visiblePasswords['password'] ? 'text' : 'password'}
              className="form-control"
              value={draft.password}
              onChange={(e) => updateDraft('password', e.target.value)}
            />
            <button
              className="btn btn-outline-secondary"
              onClick={() => toggleVisibility('password')}
            >
              <i className={`bi ${visiblePasswords['password'] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
            </button>
          </div>
        ) : (
          <div className="input-group">
            <input
              type={visiblePasswords['password'] ? 'text' : 'password'}
              className="form-control"
              value={entry.password}
              readOnly
            />
            <button
              className="btn btn-outline-secondary"
              onClick={() => toggleVisibility('password')}
            >
              <i className={`bi ${visiblePasswords['password'] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
            </button>
            <CopyBtn text={entry.password} label="password" />
          </div>
        )}
      </div>

      {/* URLs */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-link-45deg me-1"></i> URLs
        </label>
        {isEditing ? (
          <>
            {draft.urls.map((url, i) => (
              <div className="input-group mb-2" key={i}>
                <input
                  className="form-control"
                  value={url}
                  onChange={(e) => updateUrl(i, e.target.value)}
                  placeholder="https://..."
                />
                <button
                  className="btn btn-outline-danger"
                  onClick={() => removeUrl(i)}
                  title="Remove URL"
                >
                  <i className="bi bi-x-lg"></i>
                </button>
              </div>
            ))}
            <div>
              <button className="btn btn-sm btn-outline-secondary" onClick={addUrl}>
                <i className="bi bi-plus me-1"></i>Add URL
              </button>
            </div>
          </>
        ) : (
          <div>
            {data.urls.filter(Boolean).map((url, i) => (
              <div key={i} className="mb-1">
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {url}
                </a>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Hidden Fields (TOTP, secrets, etc.) */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-incognito me-1"></i> Secret Fields
        </label>
        {(isEditing ? draft.hiddenFields : data.hiddenFields).map((field) => (
          <div key={field.id} className="card card-body p-2 mb-2 bg-white">
            {isEditing ? (
              <div className="d-flex gap-2 align-items-center">
                <input
                  className="form-control form-control-sm"
                  value={field.label}
                  onChange={(e) => updateHiddenField(field.id, 'label', e.target.value)}
                  placeholder="Label (e.g. TOTP Secret)"
                  style={{ maxWidth: 180 }}
                />
                <div className="input-group input-group-sm flex-grow-1">
                  <input
                    type={visiblePasswords[`hf-${field.id}`] ? 'text' : 'password'}
                    className="form-control"
                    value={field.value}
                    onChange={(e) => updateHiddenField(field.id, 'value', e.target.value)}
                  />
                  <button
                    className="btn btn-outline-secondary"
                    onClick={() => toggleVisibility(`hf-${field.id}`)}
                  >
                    <i className={`bi ${visiblePasswords[`hf-${field.id}`] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
                  </button>
                </div>
                <button
                  className="btn btn-sm btn-outline-danger"
                  onClick={() => removeHiddenField(field.id)}
                >
                  <i className="bi bi-trash"></i>
                </button>
              </div>
            ) : (
              <div className="d-flex align-items-center">
                <span className="fw-semibold small me-2" style={{ minWidth: 120 }}>
                  {field.label}
                </span>
                <div className="input-group input-group-sm flex-grow-1">
                  <input
                    type={visiblePasswords[`hf-${field.id}`] ? 'text' : 'password'}
                    className="form-control"
                    value={field.value}
                    readOnly
                  />
                  <button
                    className="btn btn-outline-secondary"
                    onClick={() => toggleVisibility(`hf-${field.id}`)}
                  >
                    <i className={`bi ${visiblePasswords[`hf-${field.id}`] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
                  </button>
                  <CopyBtn text={field.value} label={`hf-${field.id}`} />
                </div>
              </div>
            )}
          </div>
        ))}
        {isEditing && (
          <div>
            <button className="btn btn-sm btn-outline-secondary" onClick={addHiddenField}>
              <i className="bi bi-plus me-1"></i>Add Secret Field
            </button>
          </div>
        )}
      </div>

      {/* Notes */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-sticky me-1"></i> Notes
        </label>
        {isEditing ? (
          <textarea
            className="form-control"
            rows={4}
            value={draft.notes}
            onChange={(e) => updateDraft('notes', e.target.value)}
            placeholder="Add notes..."
          />
        ) : (
          <div className="form-control bg-white" style={{ minHeight: 80, whiteSpace: 'pre-wrap' }}>
            {entry.notes || <span className="text-muted">No notes</span>}
          </div>
        )}
      </div>

      {/* Tags */}
      <div className="mb-4">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-tags me-1"></i> Tags
        </label>
        {isEditing ? (
          <input
            className="form-control"
            value={draft.tags.join(', ')}
            onChange={(e) => updateTags(e.target.value)}
            placeholder="tag1, tag2, ..."
          />
        ) : (
          <div>
            {entry.tags.map((t) => (
              <span key={t} className="badge bg-primary me-1">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="d-flex gap-2 border-top pt-3">
        {isEditing ? (
          <>
            <button className="btn btn-success" onClick={handleSave}>
              <i className="bi bi-check-lg me-1"></i>Save
            </button>
            <button className="btn btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-primary" onClick={() => onEdit(entry.id)}>
              <i className="bi bi-pencil me-1"></i>Edit
            </button>
          </>
        )}
        <button className="btn btn-outline-danger ms-auto" onClick={handleDelete}>
          <i className="bi bi-trash me-1"></i>Delete
        </button>
      </div>
    </div>
  );
}

export default EntryDetail;
