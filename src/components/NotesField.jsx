import { NOTES_MAX } from '../limits.js';

// Shared notes section used by all entry types.
// `visible` and `onToggleVisible` are controlled by the parent (which owns the
// auto-hide timer and window-blur cleanup logic).
function NotesField({ isEditing, value, onChange, visible, onToggleVisible }) {
  return (
    <div className="mb-3">
      <div className="d-flex align-items-center justify-content-between mb-1">
        <label className="form-label text-muted small fw-semibold mb-0">
          <i className="bi bi-sticky me-1"></i> Notes
        </label>
        {!isEditing && (
          <button
            className="btn btn-sm btn-outline-secondary"
            onClick={onToggleVisible}
            title={visible ? 'Hide notes' : 'Reveal notes for 15 seconds'}
          >
            <i className={`bi ${visible ? 'bi-eye-slash' : 'bi-eye'}`}></i>
          </button>
        )}
      </div>

      {isEditing ? (
        <>
          <textarea
            className={`form-control${value.length >= NOTES_MAX ? ' is-invalid' : ''}`}
            rows={4}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Add notes..."
            maxLength={NOTES_MAX}
          />
          <div className="d-flex justify-content-end mt-1">
            <span className={`small ${
              value.length >= NOTES_MAX ? 'text-danger fw-semibold' :
              value.length > NOTES_MAX * 0.9 ? 'text-warning fw-semibold' : 'text-muted'
            }`}>
              {value.length.toLocaleString()} / {NOTES_MAX.toLocaleString()} chars
              {value.length >= NOTES_MAX ? ' — limit reached' :
               value.length > NOTES_MAX * 0.9 ? ' — nearing limit' : ''}
            </span>
          </div>
          {value.length >= NOTES_MAX && (
            <div className="text-danger small mt-1">
              Notes cannot exceed {NOTES_MAX.toLocaleString()} characters
            </div>
          )}
        </>
      ) : (
        <div className="form-control bg-white" style={{ minHeight: 80, whiteSpace: 'pre-wrap' }}>
          {value ? (
            visible ? value : <span className="text-muted">Hidden. Click eye to reveal.</span>
          ) : (
            <span className="text-muted">No notes</span>
          )}
        </div>
      )}
    </div>
  );
}

export default NotesField;
