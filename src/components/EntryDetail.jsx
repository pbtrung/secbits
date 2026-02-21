import { useState, useEffect, useRef } from 'react';
import { PasswordGenerator, PasswordStrengthBar } from './PasswordGenerator';
import { generateTOTP } from '../totp.js';
import { isHttpUrl } from '../validation.js';
import {
  TITLE_MAX, USERNAME_MAX, PASSWORD_MAX, NOTES_MAX,
  URL_MAX, TOTP_SECRET_MAX,
  CUSTOM_FIELD_LABEL_MAX, CUSTOM_FIELD_VALUE_MAX,
  TAG_MAX, MAX_URLS, MAX_TOTP_SECRETS, MAX_CUSTOM_FIELDS, MAX_TAGS,
} from '../limits.js';

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

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function hasDraftChanges(draft, entry, tagCurrentInput) {
  const normalizeText = (value) => (typeof value === 'string' ? value : '');
  const normalizeArray = (value) => (Array.isArray(value) ? value : []);
  const currentTagText = tagCurrentInput.trim().toLowerCase();
  const draftTags = normalizeArray(draft?.tags);
  const tagsNow = (currentTagText && !draftTags.includes(currentTagText))
    ? [...draftTags, currentTagText]
    : draftTags;
  const tagsOrig = normalizeArray(entry?.tags);

  return (
    normalizeText(draft?.title) !== normalizeText(entry?.title) ||
    normalizeText(draft?.username) !== normalizeText(entry?.username) ||
    normalizeText(draft?.password) !== normalizeText(entry?.password) ||
    normalizeText(draft?.notes) !== normalizeText(entry?.notes) ||
    JSON.stringify(normalizeArray(draft?.urls)) !== JSON.stringify(normalizeArray(entry?.urls)) ||
    JSON.stringify(normalizeArray(draft?.totpSecrets)) !== JSON.stringify(normalizeArray(entry?.totpSecrets)) ||
    JSON.stringify(normalizeArray(draft?.customFields)) !== JSON.stringify(normalizeArray(entry?.customFields)) ||
    tagsNow.join(',') !== tagsOrig.join(',')
  );
}

function normalizeEntryForDraft(entry) {
  const safe = entry && typeof entry === 'object' ? entry : {};
  return {
    ...safe,
    urls: Array.isArray(safe.urls) ? safe.urls : [],
    totpSecrets: Array.isArray(safe.totpSecrets) ? safe.totpSecrets : [],
    customFields: Array.isArray(safe.customFields) ? safe.customFields : (Array.isArray(safe.hiddenFields) ? safe.hiddenFields : []),
    tags: Array.isArray(safe.tags) ? safe.tags : [],
  };
}

// ─── Diff helpers ─────────────────────────────────────────────────────────────

// LCS-based line diff. Returns [{type:'eq'|'add'|'del', v:string}].
function computeLineDiff(a, b) {
  const as = String(a ?? '').split('\n');
  const bs = String(b ?? '').split('\n');
  const m = as.length, n = bs.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = as[i - 1] === bs[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const out = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && as[i - 1] === bs[j - 1]) {
      out.unshift({ type: 'eq', v: as[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.unshift({ type: 'add', v: bs[j - 1] }); j--;
    } else {
      out.unshift({ type: 'del', v: as[i - 1] }); i--;
    }
  }
  return out;
}

// Collapse runs of unchanged lines that are more than CTX lines from any change.
// Inserts {type:'hunk', skip:N} markers in their place.
const CTX = 3;
function withContext(lines) {
  const near = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++)
    if (lines[i].type !== 'eq')
      for (let j = Math.max(0, i - CTX); j <= Math.min(lines.length - 1, i + CTX); j++)
        near[j] = 1;
  const out = [];
  let skip = 0;
  for (let i = 0; i < lines.length; i++) {
    if (near[i]) {
      if (skip > 0) { out.push({ type: 'hunk', skip }); skip = 0; }
      out.push(lines[i]);
    } else {
      skip++;
    }
  }
  if (skip > 0) out.push({ type: 'hunk', skip });
  return out;
}

const DIFF_FIELD_ORDER = ['title', 'username', 'password', 'notes', 'urls', 'totpSecrets', 'tags', 'customFields'];
const SCALAR_FIELDS = new Set(['title', 'username', 'password']);
const ARRAY_STR_FIELDS = new Set(['urls', 'totpSecrets', 'tags']);

// Build per-field diff sections for CommitDiff.
// fromSnap=null means initial commit: show all non-empty fields as added.
function buildDiffSections(fromSnap, toSnap, changedFields) {
  const isInit = !fromSnap;
  const fields = isInit
    ? DIFF_FIELD_ORDER.filter(f => {
        const v = toSnap?.[f];
        return Array.isArray(v) ? v.length > 0 : Boolean(v && String(v).trim());
      })
    : (changedFields?.length ? changedFields : []);

  return fields.flatMap(field => {
    const oldVal = fromSnap?.[field];
    const newVal = toSnap?.[field];

    if (field === 'notes') {
      const raw = computeLineDiff(oldVal ?? '', newVal ?? '');
      return [{ field, lines: isInit ? raw : withContext(raw) }];
    }

    if (SCALAR_FIELDS.has(field)) {
      const lines = [];
      if (oldVal) lines.push({ type: 'del', v: String(oldVal) });
      if (newVal) lines.push({ type: 'add', v: String(newVal) });
      return lines.length ? [{ field, lines }] : [];
    }

    if (ARRAY_STR_FIELDS.has(field)) {
      const a = Array.isArray(oldVal) ? oldVal : [];
      const b = Array.isArray(newVal) ? newVal : [];
      const lines = [
        ...a.filter(x => !b.includes(x)).map(x => ({ type: 'del', v: x })),
        ...b.filter(x => !a.includes(x)).map(x => ({ type: 'add', v: x })),
      ];
      return lines.length ? [{ field, lines }] : [];
    }

    if (field === 'customFields' || field === 'hiddenFields') {
      const a = Array.isArray(oldVal) ? oldVal : [];
      const b = Array.isArray(newVal) ? newVal : [];
      const lines = [];
      for (const of_ of a) {
        const nf = b.find(f => f.label === of_.label);
        if (!nf) {
          lines.push({ type: 'del', v: `[${of_.label}] ${of_.value}` });
        } else if (nf.value !== of_.value) {
          lines.push({ type: 'del', v: `[${of_.label}] ${of_.value}` });
          lines.push({ type: 'add', v: `[${nf.label}] ${nf.value}` });
        }
      }
      for (const nf of b) {
        if (!a.find(f => f.label === nf.label))
          lines.push({ type: 'add', v: `[${nf.label}] ${nf.value}` });
      }
      return lines.length ? [{ field, lines }] : [];
    }

    return [];
  });
}

// ─── CommitDiff ───────────────────────────────────────────────────────────────

function CommitDiff({ commits, idx }) {
  const commit = commits[idx];
  const parentCommit = commit?.parent
    ? commits.find(c => c.hash === commit.parent)
    : null;

  if (!commit) return null;

  const sections = buildDiffSections(
    parentCommit?.snapshot ?? null,
    commit.snapshot,
    commit.changed,
  );

  if (sections.length === 0) {
    return <p className="text-muted small mb-0">No content changes in this commit.</p>;
  }

  return (
    <div>
      {sections.map(({ field, lines }) => (
        <div key={field} className="mb-3">
          <div className="text-muted mb-1 small fw-semibold" style={{ fontFamily: 'sans-serif' }}>
            diff {field}
          </div>
          <div className="border rounded overflow-hidden" style={{ fontFamily: 'monospace', fontSize: '0.78rem', lineHeight: 1.55 }}>
            {lines.map((line, i) => {
              if (line.type === 'hunk') return (
                <div key={i} className="px-2 text-primary bg-primary bg-opacity-10" style={{ userSelect: 'none' }}>
                  @@ {line.skip} line{line.skip !== 1 ? 's' : ''} unchanged @@
                </div>
              );
              if (line.type === 'eq') return (
                <div key={i} className="px-2 text-muted" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  &nbsp;{line.v}
                </div>
              );
              if (line.type === 'del') return (
                <div key={i} className="px-2 bg-danger bg-opacity-10" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  <span className="text-danger fw-bold me-1">-</span>{line.v}
                </div>
              );
              if (line.type === 'add') return (
                <div key={i} className="px-2 bg-success bg-opacity-10" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  <span className="text-success fw-bold me-1">+</span>{line.v}
                </div>
              );
              return null;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── HistoryModal ─────────────────────────────────────────────────────────────

function HistoryModal({ commits, idx, onIdxChange, onRestore, onClose, saving, isMobile }) {
  const selectedCommit = commits[idx];
  const [mobileStep, setMobileStep] = useState(isMobile ? 'list' : 'diff');

  useEffect(() => {
    setMobileStep(isMobile ? 'list' : 'diff');
  }, [isMobile, commits.length]);

  const showList = !isMobile || mobileStep === 'list';
  const showDiff = !isMobile || mobileStep === 'diff';

  return (
    <div
      className="modal d-block history-modal"
      tabIndex="-1"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1055 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={`modal-dialog modal-dialog-scrollable ${isMobile ? 'modal-fullscreen-sm-down' : 'modal-xl'}`}
        style={{ maxHeight: '90vh' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-content" style={{ height: isMobile ? '100vh' : '85vh' }}>

          {/* Header */}
          <div className="modal-header py-2">
            <h6 className="modal-title fw-semibold mb-0">
              <i className="bi bi-git me-2"></i>
              History — {commits.length} commit{commits.length !== 1 ? 's' : ''}
            </h6>
            {isMobile && mobileStep === 'diff' && (
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary me-2"
                onClick={() => setMobileStep('list')}
              >
                <i className="bi bi-chevron-left me-1"></i>Commits
              </button>
            )}
            <button type="button" className="btn-close" onClick={onClose} />
          </div>

          {/* Body: two-panel */}
          <div className={`modal-body p-0 overflow-hidden ${isMobile ? '' : 'd-flex'}`} style={{ flex: 1, minHeight: 0 }}>

            {/* Left: commit list */}
            {showList && (
              <div
                className={`bg-light ${isMobile ? '' : 'border-end'}`}
                style={{ width: isMobile ? '100%' : 260, flexShrink: 0, overflowY: 'auto', height: '100%' }}
              >
              {commits.map((c, i) => (
                <button
                  key={c.hash}
                  type="button"
                  onClick={() => {
                    onIdxChange(i);
                    if (isMobile) setMobileStep('diff');
                  }}
                  className={`w-100 text-start border-0 border-bottom px-3 py-2${i === idx ? ' bg-primary-subtle' : ' bg-transparent'}`}
                  style={{ cursor: 'pointer' }}
                >
                  <div className="d-flex align-items-center gap-1 mb-1">
                    <code style={{ fontSize: '0.75em', letterSpacing: '0.02em' }}>{c.hash}</code>
                    {i === 0 && (
                      <span className="badge bg-success ms-1" style={{ fontSize: '0.6em' }}>HEAD</span>
                    )}
                  </div>
                  {c.changed && c.changed.length > 0 ? (
                    <div className="d-flex flex-wrap gap-1 mb-1">
                      {c.changed.map(f => (
                        <span key={f} className="badge bg-secondary" style={{ fontSize: '0.6em' }}>{f}</span>
                      ))}
                    </div>
                  ) : (
                    <div className="text-muted mb-1" style={{ fontSize: '0.72em' }}>initial commit</div>
                  )}
                  <div className="text-muted" style={{ fontSize: '0.7em' }}>
                    {formatTimestamp(c.timestamp)}
                  </div>
                </button>
              ))}
              </div>
            )}

            {/* Right: diff view */}
            {showDiff && (
              <div className="flex-grow-1 overflow-auto p-3" style={{ height: '100%' }}>
              {selectedCommit && (
                <>
                  <div className="d-flex align-items-center gap-2 mb-3 pb-2 border-bottom">
                    <code className="small">{selectedCommit.hash}</code>
                    {idx === 0 && <span className="badge bg-success">HEAD</span>}
                    <span className="text-muted small ms-auto">
                      {formatTimestamp(selectedCommit.timestamp)}
                    </span>
                  </div>
                  <CommitDiff commits={commits} idx={idx} />
                </>
              )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="modal-footer py-2">
            {idx > 0 && showDiff && (
              <button
                type="button"
                className="btn btn-sm btn-outline-warning me-auto"
                onClick={() => onRestore(selectedCommit.hash)}
                disabled={saving}
              >
                {saving
                  ? <><span className="spinner-border spinner-border-sm me-1"></span>Restoring...</>
                  : <><i className="bi bi-arrow-counterclockwise me-1"></i>Restore this version</>
                }
              </button>
            )}
            <button type="button" className="btn btn-sm btn-secondary" onClick={onClose}>
              Close
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── EntryDetail ──────────────────────────────────────────────────────────────

function EntryDetail({ entry, isEditing, onEdit, onSave, onDelete, onCancel, onRestore, saving, deleting, allTags = [], onDirtyChange, isMobile = false }) {
  const [draft, setDraft] = useState(() => normalizeEntryForDraft(entry));
  const [visiblePasswords, setVisiblePasswords] = useState({});
  const [copied, setCopied] = useState(null);
  const [tagCurrentInput, setTagCurrentInput] = useState('');
  const [tagSuggestions, setTagSuggestions] = useState([]);
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);
  const [totpErrors, setTotpErrors] = useState({});
  const [urlErrors, setUrlErrors] = useState({});
  const [tagError, setTagError] = useState('');
  const [notesVisible, setNotesVisible] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyIdx, setHistoryIdx] = useState(0);
  const notesHideTimerRef = useRef(null);
  const tagInputRef = useRef(null);

  const commits = entry._commits || [];

  useEffect(() => {
    setDraft(normalizeEntryForDraft(entry));
    setVisiblePasswords({});
    setTagCurrentInput('');
    setNotesVisible(false);
    setTotpErrors({});
    setUrlErrors({});
    setShowHistory(false);
    setHistoryIdx(0);
  }, [entry]);

  useEffect(() => {
    if (isEditing) {
      setDraft(normalizeEntryForDraft(entry));
      setTagCurrentInput('');
    }
  }, [isEditing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!onDirtyChange || !isEditing) {
      onDirtyChange?.(false);
      return;
    }
    onDirtyChange(hasDraftChanges(draft, entry, tagCurrentInput));
  }, [draft, tagCurrentInput, entry, isEditing]); // eslint-disable-line react-hooks/exhaustive-deps

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
    }, 15000);

    return () => {
      if (notesHideTimerRef.current) {
        clearTimeout(notesHideTimerRef.current);
        notesHideTimerRef.current = null;
      }
    };
  }, [notesVisible]);

  // Close modal on Escape
  useEffect(() => {
    if (!showHistory) return;
    const handler = (e) => { if (e.key === 'Escape') setShowHistory(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showHistory]);

  const toggleVisibility = (key) => {
    setVisiblePasswords((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
    setTimeout(() => navigator.clipboard.writeText(''), 30000);
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
    setUrlErrors((prev) => {
      const next = {};
      Object.entries(prev).forEach(([k, v]) => {
        const ki = Number(k);
        if (ki < index) next[ki] = v;
        else if (ki > index) next[ki - 1] = v;
      });
      return next;
    });
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
    setTotpErrors((prev) => { const next = { ...prev }; delete next[index]; return next; });
  };

  const validateTotpSecret = (index, value) => {
    if (value.length > TOTP_SECRET_MAX) {
      setTotpErrors((prev) => ({ ...prev, [index]: `TOTP secret must be ${TOTP_SECRET_MAX} characters or fewer` }));
      return;
    }
    const cleaned = value.replace(/[\s=_-]+/g, '').toUpperCase();
    const valid = cleaned.length === 0 || /^[A-Z2-7]+$/.test(cleaned);
    setTotpErrors((prev) => ({ ...prev, [index]: valid ? null : 'Invalid base32 — only A–Z and 2–7' }));
  };

  const addHiddenField = () => {
    const maxId = draft.customFields.reduce((max, f) => Math.max(max, f.id), 0);
    setDraft({
      ...draft,
      customFields: [...draft.customFields, { id: maxId + 1, label: '', value: '' }],
    });
  };

  const updateHiddenField = (id, key, value) => {
    setDraft({
      ...draft,
      customFields: draft.customFields.map((f) =>
        f.id === id ? { ...f, [key]: value } : f
      ),
    });
  };

  const removeHiddenField = (id) => {
    setDraft({
      ...draft,
      customFields: draft.customFields.filter((f) => f.id !== id),
    });
  };

  const validateUrl = (index, value) => {
    if (!value) {
      setUrlErrors((prev) => { const next = { ...prev }; delete next[index]; return next; });
      return;
    }
    if (value.length > URL_MAX) {
      setUrlErrors((prev) => ({ ...prev, [index]: `URL must be ${URL_MAX} characters or fewer` }));
      return;
    }
    if (isHttpUrl(value)) {
      setUrlErrors((prev) => { const next = { ...prev }; delete next[index]; return next; });
    } else {
      setUrlErrors((prev) => ({ ...prev, [index]: 'Invalid URL — must start with https:// or http://' }));
    }
  };

  const handleTagInputChange = (value) => {
    if (value.includes(',')) {
      const parts = value.split(',');
      const toCommit = parts.slice(0, -1).map((p) => p.trim().toLowerCase()).filter(Boolean);
      const remaining = parts[parts.length - 1];
      if (toCommit.length > 0) {
        setDraft((prev) => {
          const existing = prev.tags || [];
          const slots = MAX_TAGS - existing.length;
          if (slots <= 0) { setTagError(`Maximum ${MAX_TAGS} tags allowed`); return prev; }
          const unique = toCommit.filter((t) => !existing.includes(t)).slice(0, slots);
          if (existing.length + unique.length >= MAX_TAGS) setTagError(`Maximum ${MAX_TAGS} tags allowed`);
          else setTagError('');
          return { ...prev, tags: [...existing, ...unique] };
        });
      }
      setTagCurrentInput(remaining);
      const trimmed = remaining.trim().toLowerCase();
      if (trimmed.length > 0) {
        const existingAfter = [...(draft.tags || []), ...toCommit];
        const suggestions = allTags.filter((t) => t.startsWith(trimmed) && !existingAfter.includes(t) && t !== trimmed);
        setTagSuggestions(suggestions);
        setShowTagSuggestions(suggestions.length > 0);
      } else {
        setTagSuggestions([]);
        setShowTagSuggestions(false);
      }
      return;
    }
    setTagCurrentInput(value);
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length > 0) {
      const existing = draft.tags || [];
      const suggestions = allTags.filter((t) => t.startsWith(trimmed) && !existing.includes(t) && t !== trimmed);
      setTagSuggestions(suggestions);
      setShowTagSuggestions(suggestions.length > 0);
    } else {
      setTagSuggestions([]);
      setShowTagSuggestions(false);
    }
  };

  const handleTagKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = tagCurrentInput.trim().toLowerCase();
      if (trimmed && !(draft.tags || []).includes(trimmed)) {
        if ((draft.tags || []).length >= MAX_TAGS) {
          setTagError(`Maximum ${MAX_TAGS} tags allowed`);
        } else {
          setDraft((prev) => ({ ...prev, tags: [...(prev.tags || []), trimmed] }));
          setTagError('');
        }
      }
      setTagCurrentInput('');
      setTagSuggestions([]);
      setShowTagSuggestions(false);
    } else if (e.key === 'Backspace' && tagCurrentInput === '') {
      const tags = draft.tags || [];
      if (tags.length > 0) {
        setDraft((prev) => ({ ...prev, tags: prev.tags.slice(0, -1) }));
      }
    }
  };

  const removeTag = (tag) => {
    setDraft((prev) => ({ ...prev, tags: (prev.tags || []).filter((t) => t !== tag) }));
    setTagError('');
  };

  const selectTagSuggestion = (tag) => {
    if (!(draft.tags || []).includes(tag)) {
      if ((draft.tags || []).length >= MAX_TAGS) {
        setTagError(`Maximum ${MAX_TAGS} tags allowed`);
        return;
      }
      setDraft((prev) => ({ ...prev, tags: [...(prev.tags || []), tag] }));
      setTagError('');
    }
    setTagCurrentInput('');
    setTagSuggestions([]);
    setShowTagSuggestions(false);
    tagInputRef.current?.focus();
  };

  const handleSave = () => {
    const finalTags = [...(draft.tags || [])];
    const current = tagCurrentInput.trim().toLowerCase();
    if (current && !finalTags.includes(current)) {
      finalTags.push(current);
    }
    onSave({ ...draft, tags: finalTags });
  };

  const handleDelete = () => {
    if (window.confirm(`Delete "${entry.title || 'this entry'}"?`)) {
      onDelete(entry.id);
    }
  };

  const handleRestoreFromModal = (commitHash) => {
    onRestore(entry.id, commitHash);
    setShowHistory(false);
  };

  const hasInvalidFields =
    Object.values(totpErrors).some(Boolean) ||
    Object.values(urlErrors).some(Boolean) ||
    !!tagError ||
    draft.title.length > TITLE_MAX ||
    draft.username.length > USERNAME_MAX ||
    draft.password.length > PASSWORD_MAX ||
    draft.notes.length > NOTES_MAX ||
    draft.urls.some((u) => u.length > URL_MAX) ||
    draft.totpSecrets.some((s) => s.length > TOTP_SECRET_MAX) ||
    draft.customFields.some((f) => f.label.length > CUSTOM_FIELD_LABEL_MAX || f.value.length > CUSTOM_FIELD_VALUE_MAX) ||
    draft.tags.some((t) => t.length > TAG_MAX);

  const allFieldsEmpty =
    !draft.title.trim() &&
    !draft.username.trim() &&
    !draft.password.trim() &&
    !draft.notes.trim() &&
    !draft.urls.some((u) => u.trim()) &&
    draft.totpSecrets.length === 0 &&
    draft.customFields.length === 0 &&
    draft.tags.length === 0 &&
    !tagCurrentInput.trim();

  const saveDisabled = hasInvalidFields || allFieldsEmpty;

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
    <>
    <fieldset disabled={saving || deleting} className="p-4" style={{ maxWidth: 700 }}>
      {/* Title */}
      <div className="d-flex justify-content-between align-items-start mb-4">
        {isEditing ? (
          <input
            className="form-control form-control-lg fw-bold"
            value={draft.title}
            onChange={(e) => updateDraft('title', e.target.value)}
            placeholder="Entry Title"
            maxLength={TITLE_MAX}
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
            maxLength={USERNAME_MAX}
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
                maxLength={PASSWORD_MAX}
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
              <div key={i} className="mb-2">
                <div className="input-group">
                  <input
                    type={visiblePasswords[`totp-${i}`] ? 'text' : 'password'}
                    className={`form-control totp-secret-input${totpErrors[i] ? ' is-invalid' : ''}`}
                    value={secret}
                    onChange={(e) => updateTotpSecret(i, e.target.value)}
                    onBlur={(e) => validateTotpSecret(i, e.target.value)}
                    placeholder="TOTP secret"
                    maxLength={TOTP_SECRET_MAX}
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
                {totpErrors[i] && <div className="text-danger small mt-1">{totpErrors[i]}</div>}
              </div>
            ))}
            <div className="d-flex align-items-center gap-3">
              <button
                className="btn btn-sm btn-outline-secondary"
                onClick={addTotpSecret}
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
              <div key={i} className="mb-2">
                <div className="input-group">
                  <input
                    className={`form-control${urlErrors[i] ? ' is-invalid' : ''}`}
                    value={url}
                    onChange={(e) => updateUrl(i, e.target.value)}
                    onBlur={(e) => validateUrl(i, e.target.value)}
                    placeholder="https://..."
                    maxLength={URL_MAX}
                  />
                  <button
                    className="btn btn-outline-danger"
                    onClick={() => removeUrl(i)}
                    title="Remove URL"
                  >
                    <i className="bi bi-x-lg"></i>
                  </button>
                </div>
                {urlErrors[i] && <div className="text-danger small mt-1">{urlErrors[i]}</div>}
              </div>
            ))}
            <div className="d-flex align-items-center gap-3">
              <button
                className="btn btn-sm btn-outline-secondary"
                onClick={addUrl}
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
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {url}
                  </a>
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
                  onChange={(e) => updateHiddenField(field.id, 'label', e.target.value)}
                  placeholder="Label"
                  maxLength={CUSTOM_FIELD_LABEL_MAX}
                  style={{ maxWidth: 180 }}
                />
                <div className="input-group input-group-sm flex-grow-1">
                  <input
                    type={visiblePasswords[`hf-${field.id}`] ? 'text' : 'password'}
                    className="form-control"
                    value={field.value}
                    onChange={(e) => updateHiddenField(field.id, 'value', e.target.value)}
                    maxLength={CUSTOM_FIELD_VALUE_MAX}
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
          <div className="d-flex align-items-center gap-3">
            <button
              className="btn btn-sm btn-outline-secondary"
              onClick={addHiddenField}
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
              title={notesVisible ? 'Hide notes' : 'Reveal notes for 15 seconds'}
            >
              <i className={`bi ${notesVisible ? 'bi-eye-slash' : 'bi-eye'}`}></i>
            </button>
          )}
        </div>
        {isEditing ? (
          <>
            <textarea
              className={`form-control${draft.notes.length >= NOTES_MAX ? ' is-invalid' : ''}`}
              rows={4}
              value={draft.notes}
              onChange={(e) => updateDraft('notes', e.target.value)}
              placeholder="Add notes..."
              maxLength={NOTES_MAX}
            />
            <div className="d-flex justify-content-end mt-1">
              <span className={`small ${
                draft.notes.length >= NOTES_MAX ? 'text-danger fw-semibold' :
                draft.notes.length > NOTES_MAX * 0.9 ? 'text-warning fw-semibold' : 'text-muted'
              }`}>
                {draft.notes.length.toLocaleString()} / {NOTES_MAX.toLocaleString()} chars
                {draft.notes.length >= NOTES_MAX ? ' — limit reached' :
                 draft.notes.length > NOTES_MAX * 0.9 ? ' — nearing limit' : ''}
              </span>
            </div>
            {draft.notes.length >= NOTES_MAX && (
              <div className="text-danger small mt-1">
                Notes cannot exceed {NOTES_MAX.toLocaleString()} characters
              </div>
            )}
          </>
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
          <>
          <div className="position-relative">
            <div
              className="form-control d-flex flex-wrap gap-1 align-items-center"
              style={{ height: 'auto', minHeight: '38px', cursor: 'text', padding: '4px 8px' }}
              onClick={() => tagInputRef.current?.focus()}
            >
              {(draft.tags || []).map((t) => (
                <span key={t} className="badge bg-primary d-inline-flex align-items-center gap-1">
                  {t}
                  <button
                    type="button"
                    className="btn p-0 border-0 bg-transparent text-white lh-1"
                    aria-label={`Remove ${t}`}
                    onMouseDown={(e) => { e.preventDefault(); removeTag(t); }}
                  ><i className="bi bi-x" /></button>
                </span>
              ))}
              <input
                ref={tagInputRef}
                type="text"
                value={tagCurrentInput}
                onChange={(e) => handleTagInputChange(e.target.value)}
                onKeyDown={handleTagKeyDown}
                onBlur={() => setTimeout(() => setShowTagSuggestions(false), 150)}
                placeholder={(draft.tags || []).length === 0 ? 'Add tags...' : ''}
                maxLength={TAG_MAX}
                style={{ border: 'none', outline: 'none', flex: '1', minWidth: '80px', padding: '0', background: 'transparent' }}
              />
            </div>
            {showTagSuggestions && (
              <ul className="dropdown-menu show position-absolute w-100 mt-1" style={{ zIndex: 1000, maxHeight: 200, overflowY: 'auto' }}>
                {tagSuggestions.slice(0, 8).map((t) => (
                  <li key={t}>
                    <button
                      className="dropdown-item"
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); selectTagSuggestion(t); }}
                    >
                      {t}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="d-flex justify-content-between mt-1">
            {tagError
              ? <span className="text-danger small">{tagError}</span>
              : <span />}
            {(draft.tags || []).length > 0 && (
              <span className={`small ${(draft.tags || []).length >= MAX_TAGS ? 'text-danger' : 'text-muted'}`}>
                {(draft.tags || []).length} / {MAX_TAGS} tags
              </span>
            )}
          </div>
          </>
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

      {/* Action Buttons */}
      <div className="d-flex gap-2 align-items-center border-top pt-3 flex-wrap">
        {isEditing ? (
          <>
            <button className="btn btn-success" onClick={handleSave} disabled={saveDisabled}>
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

        {commits.length > 0 && (
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => { setHistoryIdx(0); setShowHistory(true); }}
          >
            <i className="bi bi-git me-1"></i>
            {commits.length} commit{commits.length !== 1 ? 's' : ''}
          </button>
        )}

        {!entry._isNew && (
          <button className="btn btn-outline-danger ms-auto" onClick={handleDelete}>
            {deleting ? (
              <><span className="spinner-border spinner-border-sm me-1"></span>Deleting...</>
            ) : (
              <><i className="bi bi-trash me-1"></i>Delete</>
            )}
          </button>
        )}
      </div>
    </fieldset>

    {showHistory && (
      <HistoryModal
        commits={commits}
        idx={historyIdx}
        onIdxChange={setHistoryIdx}
        onRestore={handleRestoreFromModal}
        onClose={() => setShowHistory(false)}
        saving={saving}
        isMobile={isMobile}
      />
    )}
    </>
  );
}

export default EntryDetail;
