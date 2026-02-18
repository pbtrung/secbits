import React, { useState, useEffect, useRef } from 'react';
import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { PasswordGenerator, PasswordStrengthBar } from './PasswordGenerator';

function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  str = str.replace(/[\s=_-]+/g, '').toUpperCase();
  let bits = '';
  for (const c of str) {
    const val = alphabet.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, (i + 1) * 8), 2);
  }
  return bytes;
}

function generateTOTP(secret) {
  try {
    const key = base32Decode(secret);
    if (key.length === 0) return null;
    const counter = Math.floor(Date.now() / 1000 / 30);
    const counterBytes = new Uint8Array(8);
    let tmp = counter;
    for (let i = 7; i >= 0; i--) {
      counterBytes[i] = tmp & 0xff;
      tmp = Math.floor(tmp / 256);
    }
    const mac = hmac(sha1, key, counterBytes);
    const offset = mac[mac.length - 1] & 0x0f;
    const code =
      ((mac[offset] & 0x7f) << 24) |
      ((mac[offset + 1] & 0xff) << 16) |
      ((mac[offset + 2] & 0xff) << 8) |
      (mac[offset + 3] & 0xff);
    return String(code % 1000000).padStart(6, '0');
  } catch {
    return null;
  }
}

function TotpCode({ secret, onCopy, copiedLabel }) {
  const [code, setCode] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(30);

  useEffect(() => {
    const update = () => {
      const now = Math.floor(Date.now() / 1000);
      setSecondsLeft(30 - (now % 30));
      setCode(generateTOTP(secret));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [secret]);

  if (!code) return null;

  const formatted = code.slice(0, 3) + '\u2009' + code.slice(3);
  const progress = secondsLeft / 30;
  const circumference = 2 * Math.PI * 10;

  return (
    <div className="d-flex align-items-center ms-3 gap-2 flex-shrink-0">
      <span className="totp-code fw-bold">{formatted}</span>
      <svg width="22" height="22" viewBox="0 0 24 24" className="flex-shrink-0">
        <circle cx="12" cy="12" r="10" fill="none" stroke="#dee2e6" strokeWidth="2.5" />
        <circle
          cx="12" cy="12" r="10" fill="none"
          stroke={secondsLeft <= 5 ? '#dc3545' : '#0d6efd'}
          strokeWidth="2.5"
          strokeDasharray={`${progress * circumference} ${circumference}`}
          transform="rotate(-90 12 12)"
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 1s linear, stroke 0.3s' }}
        />
      </svg>
      <button
        className="btn btn-sm btn-outline-secondary border-0 p-1"
        onClick={() => onCopy(code)}
        title="Copy code"
      >
        <i className={`bi ${copiedLabel ? 'bi-check-lg text-success' : 'bi-clipboard'}`}></i>
      </button>
    </div>
  );
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function EntryDetail({ entry, isEditing, onEdit, onSave, onDelete, onCancel, saving, deleting, onDirtyChange }) {
  const [draft, setDraft] = useState(entry);
  const [visiblePasswords, setVisiblePasswords] = useState({});
  const [copied, setCopied] = useState(null);
  const [tagsInput, setTagsInput] = useState('');
  const [selectedVersion, setSelectedVersion] = useState(0);
  const [notesVisible, setNotesVisible] = useState(false);
  const notesHideTimerRef = useRef(null);

  const snapshots = entry._snapshots || [];
  const selectedSnapshot = snapshots.length > 1 && selectedVersion > 0
    ? snapshots[selectedVersion]
    : null;
  const viewEntry = selectedSnapshot
    ? { ...entry, ...selectedSnapshot, id: entry.id, _snapshots: entry._snapshots }
    : entry;

  useEffect(() => {
    setDraft(entry);
    setVisiblePasswords({});
    setTagsInput(Array.isArray(entry.tags) ? entry.tags.join(', ') : '');
    setSelectedVersion(0);
    setNotesVisible(false);
  }, [entry]);

  useEffect(() => {
    if (isEditing) {
      setDraft(viewEntry);
      setTagsInput(Array.isArray(viewEntry.tags) ? viewEntry.tags.join(', ') : '');
    }
  }, [isEditing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!onDirtyChange || !isEditing) {
      onDirtyChange?.(false);
      return;
    }
    const tagsNow = tagsInput.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).join(',');
    const tagsOrig = (Array.isArray(entry.tags) ? entry.tags : []).join(',');
    const dirty =
      draft.title !== entry.title ||
      draft.username !== entry.username ||
      draft.password !== entry.password ||
      draft.notes !== entry.notes ||
      JSON.stringify(draft.urls) !== JSON.stringify(entry.urls) ||
      JSON.stringify(draft.totpSecrets) !== JSON.stringify(entry.totpSecrets) ||
      JSON.stringify(draft.hiddenFields) !== JSON.stringify(entry.hiddenFields) ||
      tagsNow !== tagsOrig;
    onDirtyChange(dirty);
  }, [draft, tagsInput, entry, isEditing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const hideNotes = () => setNotesVisible(false);
    const onVisibilityChange = () => {
      if (document.hidden) hideNotes();
    };
    window.addEventListener('blur', hideNotes);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', hideNotes);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (isEditing) setNotesVisible(false);
  }, [isEditing]);

  useEffect(() => {
    if (!notesVisible) {
      if (notesHideTimerRef.current) {
        clearTimeout(notesHideTimerRef.current);
        notesHideTimerRef.current = null;
      }
      return;
    }
    notesHideTimerRef.current = setTimeout(() => {
      setNotesVisible(false);
      notesHideTimerRef.current = null;
    }, 30000);

    return () => {
      if (notesHideTimerRef.current) {
        clearTimeout(notesHideTimerRef.current);
        notesHideTimerRef.current = null;
      }
    };
  }, [notesVisible]);

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

  const addTotpSecret = () => setDraft({ ...draft, totpSecrets: [...draft.totpSecrets, ''] });

  const updateTotpSecret = (index, value) => {
    const totpSecrets = [...draft.totpSecrets];
    totpSecrets[index] = value;
    setDraft({ ...draft, totpSecrets });
  };

  const removeTotpSecret = (index) => {
    const totpSecrets = draft.totpSecrets.filter((_, i) => i !== index);
    setDraft({ ...draft, totpSecrets });
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

  const parseTagsInput = (value) =>
    value
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

  const updateTags = (value) => {
    setTagsInput(value);
  };

  const handleSave = () => {
    onSave({ ...draft, tags: parseTagsInput(tagsInput) });
  };

  const handleVersionChange = (index) => {
    setSelectedVersion(index);
    if (isEditing && snapshots.length > 1) {
      const snap = index > 0 ? snapshots[index] : entry;
      setDraft({ ...snap, id: entry.id, _snapshots: entry._snapshots });
      setTagsInput(Array.isArray(snap.tags) ? snap.tags.join(', ') : '');
    }
  };

  const handleDelete = () => {
    if (window.confirm(`Delete "${entry.title || 'this entry'}"?`)) {
      onDelete(entry.id);
    }
  };

  const data = isEditing ? draft : viewEntry;

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
    <fieldset disabled={saving || deleting} className="p-4" style={{ maxWidth: 700 }}>
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
          <h3 className="fw-bold mb-0">{data.title}</h3>
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
            <input className="form-control" value={data.username} readOnly />
            <CopyBtn text={data.username} label="username" />
          </div>
        )}
      </div>

      {/* Password */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-lock me-1"></i> Password
        </label>
        {isEditing ? (
          <>
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
            <PasswordStrengthBar password={draft.password} />
            <PasswordGenerator
              onGenerate={(pw) => updateDraft('password', pw)}
              onCopy={(pw) => copyToClipboard(pw, 'password')}
            />
          </>
        ) : (
          <div className="input-group">
            <input
              type={visiblePasswords['password'] ? 'text' : 'password'}
              className="form-control"
              value={data.password}
              readOnly
            />
            <button
              className="btn btn-outline-secondary"
              onClick={() => toggleVisibility('password')}
            >
              <i className={`bi ${visiblePasswords['password'] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
            </button>
            <CopyBtn text={data.password} label="password" />
          </div>
        )}
      </div>

      {/* TOTP Secrets */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-clock-history me-1"></i> TOTP Secrets
        </label>
        {isEditing ? (
          <>
            {draft.totpSecrets.map((secret, i) => (
              <div className="input-group mb-2" key={i}>
                <input
                  type={visiblePasswords[`totp-${i}`] ? 'text' : 'password'}
                  className="form-control totp-secret-input"
                  value={secret}
                  onChange={(e) => updateTotpSecret(i, e.target.value)}
                  placeholder="TOTP secret"
                />
                <button
                  className="btn btn-outline-secondary"
                  onClick={() => toggleVisibility(`totp-${i}`)}
                >
                  <i className={`bi ${visiblePasswords[`totp-${i}`] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
                </button>
                <button
                  className="btn btn-outline-danger"
                  onClick={() => removeTotpSecret(i)}
                  title="Remove TOTP Secret"
                >
                  <i className="bi bi-x-lg"></i>
                </button>
              </div>
            ))}
            <div>
              <button className="btn btn-sm btn-outline-secondary" onClick={addTotpSecret}>
                <i className="bi bi-plus me-1"></i>Add TOTP Secret
              </button>
            </div>
          </>
        ) : (
          <div>
            {data.totpSecrets.filter(Boolean).map((secret, i) => (
              <div className="d-flex align-items-center mb-2" key={i}>
                <div className="input-group input-group-sm" style={{ flex: '1 1 0', minWidth: 0 }}>
                  <input
                    type={visiblePasswords[`totp-${i}`] ? 'text' : 'password'}
                    className="form-control totp-secret-input"
                    value={secret}
                    readOnly
                  />
                  <button
                    className="btn btn-outline-secondary"
                    onClick={() => toggleVisibility(`totp-${i}`)}
                  >
                    <i className={`bi ${visiblePasswords[`totp-${i}`] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
                  </button>
                  <CopyBtn text={secret} label={`totp-${i}`} />
                </div>
                <TotpCode
                  secret={secret}
                  onCopy={(code) => copyToClipboard(code, `totp-code-${i}`)}
                  copiedLabel={copied === `totp-code-${i}`}
                />
              </div>
            ))}
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

      {/* Extra Fields */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-incognito me-1"></i> Extra Fields
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
              <i className="bi bi-plus me-1"></i>Add Extra Field
            </button>
          </div>
        )}
      </div>

      {/* Notes */}
      <div className="mb-3">
        <div className="d-flex align-items-center justify-content-between mb-1">
          <label className="form-label text-muted small fw-semibold mb-0">
            <i className="bi bi-sticky me-1"></i> Notes
          </label>
          {!isEditing && (
            <button
              className="btn btn-sm btn-outline-secondary"
              onClick={() => setNotesVisible((v) => !v)}
              title={notesVisible ? 'Hide notes' : 'Reveal notes for 30 seconds'}
            >
              <i className={`bi ${notesVisible ? 'bi-eye-slash' : 'bi-eye'}`}></i>
            </button>
          )}
        </div>
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
            {data.notes ? (
              notesVisible ? data.notes : <span className="text-muted">Hidden. Click eye to reveal.</span>
            ) : (
              <span className="text-muted">No notes</span>
            )}
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
            value={tagsInput}
            onChange={(e) => updateTags(e.target.value)}
            placeholder="tag1, tag2, ..."
          />
        ) : (
          <div>
            {data.tags.map((t) => (
              <span key={t} className="badge bg-primary me-1">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Versions */}
      {snapshots.length >= 2 && (
        <div className="mb-4">
          <label className="form-label text-muted small fw-semibold">
            <i className="bi bi-journal-text me-1"></i> Versions
          </label>
          <select
            className="form-select form-select-sm"
            style={{ width: 'auto' }}
            value={selectedVersion}
            onChange={(e) => handleVersionChange(Number(e.target.value))}
          >
            {snapshots.map((s, i) => (
              <option key={i} value={i}>
                {formatTimestamp(s.timestamp)}{i === 0 ? ' (latest)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Action Buttons */}
      <div className="d-flex gap-2 align-items-center border-top pt-3">
        {isEditing ? (
          <>
            <button className="btn btn-success" onClick={handleSave}>
              {saving ? (
                <><span className="spinner-border spinner-border-sm me-1"></span>Saving...</>
              ) : (
                <><i className="bi bi-check-lg me-1"></i>Save</>
              )}
            </button>
            <button className="btn btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={() => onEdit(entry.id)}>
            <i className="bi bi-pencil me-1"></i>Edit
          </button>
        )}
        <button className="btn btn-outline-danger ms-auto" onClick={handleDelete}>
          {deleting ? (
            <><span className="spinner-border spinner-border-sm me-1"></span>Deleting...</>
          ) : (
            <><i className="bi bi-trash me-1"></i>Delete</>
          )}
        </button>
      </div>
    </fieldset>
  );
}

export default EntryDetail;
