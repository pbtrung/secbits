import { useEffect, useState } from 'react';

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// LCS-based line diff. Returns [{type:'eq'|'add'|'del', v:string}].
function computeLineDiff(a, b) {
  const as = String(a ?? '').split('\n');
  const bs = String(b ?? '').split('\n');
  const m = as.length;
  const n = bs.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = as[i - 1] === bs[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && as[i - 1] === bs[j - 1]) {
      out.unshift({ type: 'eq', v: as[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.unshift({ type: 'add', v: bs[j - 1] });
      j--;
    } else {
      out.unshift({ type: 'del', v: as[i - 1] });
      i--;
    }
  }
  return out;
}

// Collapse runs of unchanged lines that are more than CTX lines from any change.
// Inserts {type:'hunk', skip:N} markers in their place.
const CTX = 3;
function withContext(lines) {
  const near = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== 'eq') {
      for (let j = Math.max(0, i - CTX); j <= Math.min(lines.length - 1, i + CTX); j++) {
        near[j] = 1;
      }
    }
  }
  const out = [];
  let skip = 0;
  for (let i = 0; i < lines.length; i++) {
    if (near[i]) {
      if (skip > 0) {
        out.push({ type: 'hunk', skip });
        skip = 0;
      }
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
    ? DIFF_FIELD_ORDER.filter((f) => {
      const v = toSnap?.[f];
      return Array.isArray(v) ? v.length > 0 : Boolean(v && String(v).trim());
    })
    : (changedFields?.length ? changedFields : []);

  return fields.flatMap((field) => {
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
        ...a.filter((x) => !b.includes(x)).map((x) => ({ type: 'del', v: x })),
        ...b.filter((x) => !a.includes(x)).map((x) => ({ type: 'add', v: x })),
      ];
      return lines.length ? [{ field, lines }] : [];
    }

    if (field === 'customFields' || field === 'hiddenFields') {
      const a = Array.isArray(oldVal) ? oldVal : [];
      const b = Array.isArray(newVal) ? newVal : [];
      const lines = [];
      for (const of_ of a) {
        const nf = b.find((f) => f.label === of_.label);
        if (!nf) {
          lines.push({ type: 'del', v: `[${of_.label}] ${of_.value}` });
        } else if (nf.value !== of_.value) {
          lines.push({ type: 'del', v: `[${of_.label}] ${of_.value}` });
          lines.push({ type: 'add', v: `[${nf.label}] ${nf.value}` });
        }
      }
      for (const nf of b) {
        if (!a.find((f) => f.label === nf.label)) {
          lines.push({ type: 'add', v: `[${nf.label}] ${nf.value}` });
        }
      }
      return lines.length ? [{ field, lines }] : [];
    }

    return [];
  });
}

function CommitDiff({ commits, idx }) {
  const commit = commits[idx];
  const parentCommit = commit?.parent
    ? commits.find((c) => c.hash === commit.parent)
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
            {field}
          </div>
          <div className="border rounded overflow-hidden" style={{ fontFamily: 'monospace', fontSize: '0.78rem', lineHeight: 1.55 }}>
            {lines.map((line, i) => {
              if (line.type === 'hunk') {
                return (
                  <div key={i} className="px-2 text-primary bg-primary bg-opacity-10" style={{ userSelect: 'none' }}>
                    @@ {line.skip} line{line.skip !== 1 ? 's' : ''} unchanged @@
                  </div>
                );
              }
              if (line.type === 'eq') {
                return (
                  <div key={i} className="px-2 text-muted" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    &nbsp;{line.v}
                  </div>
                );
              }
              if (line.type === 'del') {
                return (
                  <div key={i} className="px-2 bg-danger bg-opacity-10" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    <span className="text-danger fw-bold me-1">-</span>{line.v}
                  </div>
                );
              }
              if (line.type === 'add') {
                return (
                  <div key={i} className="px-2 bg-success bg-opacity-10" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    <span className="text-success fw-bold me-1">+</span>{line.v}
                  </div>
                );
              }
              return null;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function HistoryDiffModal({ commits, idx, onIdxChange, onRestore, onClose, saving, isMobile }) {
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
      onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <div
        className={`modal-dialog modal-dialog-scrollable ${isMobile ? 'modal-fullscreen-sm-down' : 'modal-xl'}`}
        style={{ maxHeight: '90vh' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-content" style={{ height: isMobile ? '100vh' : '85vh' }}>
          <div className="modal-header py-2">
            <h6 className="modal-title fw-semibold mb-0">
              <i className="bi bi-git me-2"></i>
              History - {commits.length} commit{commits.length !== 1 ? 's' : ''}
            </h6>
            <div className="d-flex align-items-center gap-2 ms-auto">
              {isMobile && (
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary flex-shrink-0"
                  onClick={() => {
                    if (mobileStep === 'diff') setMobileStep('list');
                    else onClose();
                  }}
                  disabled={saving}
                  aria-label="Back to commits"
                  title="Back to commits"
                >
                  <i className="bi bi-chevron-left"></i>
                </button>
              )}
            </div>
          </div>

          <div className={`modal-body p-0 overflow-hidden ${isMobile ? '' : 'd-flex'}`} style={{ flex: 1, minHeight: 0 }}>
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
                        {c.changed.map((f) => (
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
            <button type="button" className="btn btn-sm btn-secondary" onClick={onClose} disabled={saving}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default HistoryDiffModal;
