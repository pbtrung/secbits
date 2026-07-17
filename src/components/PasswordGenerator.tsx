import { useState, useEffect, useCallback } from 'react';

interface StrengthInfo {
  entropy: number;
  label: string;
  colorClass: string;
}

function estimatePasswordEntropy(password: string): number {
  let poolSize = 0;
  if (/[a-z]/.test(password)) poolSize += 26;
  if (/[A-Z]/.test(password)) poolSize += 26;
  if (/[0-9]/.test(password)) poolSize += 10;
  if (/[^a-zA-Z0-9]/.test(password)) poolSize += 30;
  return password.length * Math.log2(poolSize || 1);
}

function strengthLabelFor(entropy: number): { label: string; colorClass: string } {
  if (entropy < 36) return { label: 'Weak', colorClass: 'bg-danger' };
  if (entropy < 60) return { label: 'Fair', colorClass: 'bg-warning' };
  if (entropy < 80) return { label: 'Good', colorClass: 'bg-info' };
  return { label: 'Strong', colorClass: 'bg-success' };
}

function evaluateStrength(password: string): StrengthInfo {
  if (!password) return { entropy: 0, label: '', colorClass: '' };
  const entropy = estimatePasswordEntropy(password);
  return { entropy, ...strengthLabelFor(entropy) };
}

export function PasswordStrengthBar({ password }: { password: string }) {
  if (!password) return null;

  const { entropy, label, colorClass } = evaluateStrength(password);
  const widthPercent = Math.min(100, (entropy / 128) * 100);

  return (
    <div className="mt-1">
      <div className="progress" style={{ height: 5 }}>
        <div
          className={`progress-bar ${colorClass}`}
          role="progressbar"
          style={{ width: `${widthPercent}%`, transition: 'width 0.3s' }}
        />
      </div>
      <div className="d-flex justify-content-between mt-1" style={{ fontSize: '0.75rem' }}>
        <span className="text-muted">{label}</span>
        <span className="text-muted">{Math.round(entropy)} bits</span>
      </div>
    </div>
  );
}

type CharsetKey = 'lowercase' | 'uppercase' | 'digits' | 'symbols';

const CHARSETS: Record<CharsetKey, { label: string; chars: string }> = {
  lowercase: { label: 'a-z', chars: 'abcdefghijklmnopqrstuvwxyz' },
  uppercase: { label: 'A-Z', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  digits: { label: '0-9', chars: '0123456789' },
  symbols: { label: '!@#', chars: "!@#$%^&*()_+-=[]{}|;:,.<>?/~`'" },
};

function getEnabledCharsets(charsets: Record<CharsetKey, boolean>): CharsetKey[] {
  const allKeys = Object.keys(charsets) as CharsetKey[];
  return allKeys.filter((key) => charsets[key]);
}

function generatePassword(length: number, enabledSets: CharsetKey[]): string {
  let pool = '';
  for (const key of enabledSets) {
    pool += CHARSETS[key].chars;
  }
  if (!pool) return '';

  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += pool[arr[i] % pool.length];
  }
  return result;
}

interface PasswordGeneratorProps {
  onGenerate: (password: string) => void;
  onCopy: (password: string) => void;
}

export function PasswordGenerator({ onGenerate, onCopy }: PasswordGeneratorProps) {
  const [open, setOpen] = useState(false);
  const [length, setLength] = useState(20);
  const [charsets, setCharsets] = useState<Record<CharsetKey, boolean>>({
    lowercase: true,
    uppercase: true,
    digits: true,
    symbols: true,
  });
  const [preview, setPreview] = useState('');

  const enabledSets = getEnabledCharsets(charsets);

  const regenerate = useCallback(() => {
    setPreview(generatePassword(length, getEnabledCharsets(charsets)));
  }, [length, charsets]);

  useEffect(() => {
    if (open) regenerate();
  }, [open, regenerate]);

  const toggleCharset = (key: CharsetKey) => {
    if (charsets[key] && enabledSets.length <= 1) return;
    setCharsets((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleToggle = () => {
    if (!open) {
      setLength(20);
      setCharsets({ lowercase: true, uppercase: true, digits: true, symbols: true });
      setPreview('');
    }
    setOpen(!open);
  };

  return (
    <div className="mt-2">
      <button className="btn btn-sm btn-outline-secondary" onClick={handleToggle} type="button">
        <i className="bi bi-arrow-repeat me-1"></i>
        Generate Password
      </button>

      {open && (
        <div className="card card-body p-3 mt-2 bg-light">
          {/* Length slider */}
          <div className="mb-3">
            <label className="form-label small mb-1">
              Length: <strong>{length}</strong>
            </label>
            <input
              type="range"
              className="form-range"
              min={8}
              max={128}
              value={length}
              onChange={(e) => setLength(Number(e.target.value))}
            />
          </div>

          {/* Charset checkboxes */}
          <div className="mb-3">
            {(Object.keys(CHARSETS) as CharsetKey[]).map((key) => (
              <div className="form-check form-check-inline" key={key}>
                <input
                  className="form-check-input"
                  type="checkbox"
                  id={`charset-${key}`}
                  checked={charsets[key]}
                  onChange={() => toggleCharset(key)}
                  disabled={charsets[key] && enabledSets.length <= 1}
                />
                <label className="form-check-label small" htmlFor={`charset-${key}`}>
                  {CHARSETS[key].label}
                </label>
              </div>
            ))}
          </div>

          {/* Preview + buttons */}
          <div className="input-group input-group-sm">
            <input type="text" className="form-control" value={preview} readOnly style={{ fontFamily: 'monospace' }} />
            <button className="btn btn-outline-secondary" onClick={() => onCopy(preview)} title="Copy" type="button">
              <i className="bi bi-clipboard"></i>
            </button>
            <button className="btn btn-outline-secondary" onClick={regenerate} title="Regenerate" type="button">
              <i className="bi bi-arrow-repeat"></i>
            </button>
            <button
              className="btn btn-primary"
              onClick={() => onGenerate(preview)}
              title="Use this password"
              type="button"
            >
              <i className="bi bi-check-lg"></i>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
