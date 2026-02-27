import { useState, useEffect } from 'react';
import { PasswordGenerator, PasswordStrengthBar } from './PasswordGenerator';
import CopyBtn from './CopyBtn';
import { generateTOTP } from '../totp.js';
import { isHttpUrl } from '../validation.js';
import {
  USERNAME_MAX, PASSWORD_MAX,
  URL_MAX, TOTP_SECRET_MAX,
  CUSTOM_FIELD_LABEL_MAX, CUSTOM_FIELD_VALUE_MAX,
  MAX_URLS, MAX_TOTP_SECRETS, MAX_CUSTOM_FIELDS,
} from '../limits.js';

function TotpCode({ secret, onCopy, copiedLabel }) {
  const [code, setCode] = useState(() => generateTOTP(secret));
  const [secondsLeft, setSecondsLeft] = useState(() => 30 - (Math.floor(Date.now() / 1000) % 30));

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

  if (!code) return <span className="text-danger small ms-3">Invalid TOTP secret</span>;

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

function LoginFields({
  draft, data, isEditing,
  visiblePasswords, onToggle, copied, onCopy, onUpdate,
  onAddUrl, onUpdateUrl, onRemoveUrl, onValidateUrl, urlErrors,
  onAddTotp, onUpdateTotp, onRemoveTotp, onValidateTotp, totpErrors,
  onAddCustomField, onUpdateCustomField, onRemoveCustomField,
}) {
  return (
    <>
      {/* Username */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-person me-1"></i> Username
        </label>
        {isEditing ? (
          <input
            className="form-control"
            value={draft.username}
            onChange={(e) => onUpdate('username', e.target.value)}
            maxLength={USERNAME_MAX}
          />
        ) : (
          <div className="input-group">
            <input className="form-control" value={data.username} readOnly />
            <CopyBtn text={data.username} label="username" copied={copied} onCopy={onCopy} />
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
                onChange={(e) => onUpdate('password', e.target.value)}
                maxLength={PASSWORD_MAX}
              />
              <button className="btn btn-outline-secondary" onClick={() => onToggle('password')}>
                <i className={`bi ${visiblePasswords['password'] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
              </button>
            </div>
            <PasswordStrengthBar password={draft.password} />
            <PasswordGenerator
              onGenerate={(pw) => onUpdate('password', pw)}
              onCopy={(pw) => onCopy(pw, 'password')}
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
            <button className="btn btn-outline-secondary" onClick={() => onToggle('password')}>
              <i className={`bi ${visiblePasswords['password'] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
            </button>
            <CopyBtn text={data.password} label="password" copied={copied} onCopy={onCopy} />
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
              <div key={i} className="mb-2">
                <div className="input-group">
                  <input
                    type={visiblePasswords[`totp-${i}`] ? 'text' : 'password'}
                    className={`form-control totp-secret-input${totpErrors[i] ? ' is-invalid' : ''}`}
                    value={secret}
                    onChange={(e) => onUpdateTotp(i, e.target.value)}
                    onBlur={(e) => onValidateTotp(i, e.target.value)}
                    placeholder="TOTP secret"
                    maxLength={TOTP_SECRET_MAX}
                  />
                  <button className="btn btn-outline-secondary" onClick={() => onToggle(`totp-${i}`)}>
                    <i className={`bi ${visiblePasswords[`totp-${i}`] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
                  </button>
                  <button className="btn btn-outline-danger" onClick={() => onRemoveTotp(i)} title="Remove TOTP Secret">
                    <i className="bi bi-x-lg"></i>
                  </button>
                </div>
                {totpErrors[i] && <div className="text-danger small mt-1">{totpErrors[i]}</div>}
              </div>
            ))}
            <div className="d-flex align-items-center gap-3">
              <button
                className="btn btn-sm btn-outline-secondary"
                onClick={onAddTotp}
                disabled={draft.totpSecrets.length >= MAX_TOTP_SECRETS}
                title={draft.totpSecrets.length >= MAX_TOTP_SECRETS ? `Maximum ${MAX_TOTP_SECRETS} TOTP secrets allowed` : undefined}
              >
                <i className="bi bi-plus me-1"></i>Add TOTP Secret
              </button>
              {draft.totpSecrets.length > 0 && (
                <span className={`small ${draft.totpSecrets.length >= MAX_TOTP_SECRETS ? 'text-danger' : 'text-muted'}`}>
                  {draft.totpSecrets.length} / {MAX_TOTP_SECRETS}
                </span>
              )}
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
                  <button className="btn btn-outline-secondary" onClick={() => onToggle(`totp-${i}`)}>
                    <i className={`bi ${visiblePasswords[`totp-${i}`] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
                  </button>
                  <CopyBtn text={secret} label={`totp-${i}`} copied={copied} onCopy={onCopy} />
                </div>
                <TotpCode
                  secret={secret}
                  onCopy={(code) => onCopy(code, `totp-code-${i}`)}
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
              <div key={i} className="mb-2">
                <div className="input-group">
                  <input
                    className={`form-control${urlErrors[i] ? ' is-invalid' : ''}`}
                    value={url}
                    onChange={(e) => onUpdateUrl(i, e.target.value)}
                    onBlur={(e) => onValidateUrl(i, e.target.value)}
                    placeholder="https://..."
                    maxLength={URL_MAX}
                  />
                  <button className="btn btn-outline-danger" onClick={() => onRemoveUrl(i)} title="Remove URL">
                    <i className="bi bi-x-lg"></i>
                  </button>
                </div>
                {urlErrors[i] && <div className="text-danger small mt-1">{urlErrors[i]}</div>}
              </div>
            ))}
            <div className="d-flex align-items-center gap-3">
              <button
                className="btn btn-sm btn-outline-secondary"
                onClick={onAddUrl}
                disabled={draft.urls.length >= MAX_URLS}
                title={draft.urls.length >= MAX_URLS ? `Maximum ${MAX_URLS} URLs allowed` : undefined}
              >
                <i className="bi bi-plus me-1"></i>Add URL
              </button>
              {draft.urls.length > 0 && (
                <span className={`small ${draft.urls.length >= MAX_URLS ? 'text-danger' : 'text-muted'}`}>
                  {draft.urls.length} / {MAX_URLS}
                </span>
              )}
            </div>
          </>
        ) : (
          <div>
            {data.urls.filter(Boolean).map((url, i) => (
              <div key={i} className="mb-1">
                {isHttpUrl(url) ? (
                  <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
                ) : (
                  <span className="text-muted">{url}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Custom Fields */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-incognito me-1"></i> Custom Fields
        </label>
        {(isEditing ? draft.customFields : data.customFields).map((field) => (
          <div key={field.id} className="card card-body p-2 mb-2 bg-white">
            {isEditing ? (
              <div className="d-flex gap-2 align-items-center">
                <input
                  className="form-control form-control-sm"
                  value={field.label}
                  onChange={(e) => onUpdateCustomField(field.id, 'label', e.target.value)}
                  placeholder="Label"
                  maxLength={CUSTOM_FIELD_LABEL_MAX}
                  style={{ maxWidth: 180 }}
                />
                <div className="input-group input-group-sm flex-grow-1">
                  <input
                    type={visiblePasswords[`hf-${field.id}`] ? 'text' : 'password'}
                    className="form-control totp-secret-input custom-field-secret-input"
                    value={field.value}
                    onChange={(e) => onUpdateCustomField(field.id, 'value', e.target.value)}
                    maxLength={CUSTOM_FIELD_VALUE_MAX}
                  />
                  <button className="btn btn-outline-secondary" onClick={() => onToggle(`hf-${field.id}`)}>
                    <i className={`bi ${visiblePasswords[`hf-${field.id}`] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
                  </button>
                </div>
                <button className="btn btn-sm btn-outline-danger" onClick={() => onRemoveCustomField(field.id)}>
                  <i className="bi bi-trash"></i>
                </button>
              </div>
            ) : (
              <div className="d-flex align-items-center">
                <span className="fw-semibold small me-2" style={{ minWidth: 120 }}>{field.label}</span>
                <div className="input-group input-group-sm flex-grow-1">
                  <input
                    type={visiblePasswords[`hf-${field.id}`] ? 'text' : 'password'}
                    className="form-control totp-secret-input custom-field-secret-input"
                    value={field.value}
                    readOnly
                  />
                  <button className="btn btn-outline-secondary" onClick={() => onToggle(`hf-${field.id}`)}>
                    <i className={`bi ${visiblePasswords[`hf-${field.id}`] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
                  </button>
                  <CopyBtn text={field.value} label={`hf-${field.id}`} copied={copied} onCopy={onCopy} />
                </div>
              </div>
            )}
          </div>
        ))}
        {isEditing && (
          <div className="d-flex align-items-center gap-3">
            <button
              className="btn btn-sm btn-outline-secondary"
              onClick={onAddCustomField}
              disabled={draft.customFields.length >= MAX_CUSTOM_FIELDS}
              title={draft.customFields.length >= MAX_CUSTOM_FIELDS ? `Maximum ${MAX_CUSTOM_FIELDS} custom fields allowed` : undefined}
            >
              <i className="bi bi-plus me-1"></i>Add Custom Field
            </button>
            {draft.customFields.length > 0 && (
              <span className={`small ${draft.customFields.length >= MAX_CUSTOM_FIELDS ? 'text-danger' : 'text-muted'}`}>
                {draft.customFields.length} / {MAX_CUSTOM_FIELDS}
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}

export default LoginFields;
