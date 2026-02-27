import { useState, useEffect, useRef } from 'react';
import { TAG_MAX, MAX_TAGS } from '../limits.js';

// Shared tags section used by all entry types.
//
// Props:
//   tags              — controlled array of tag strings (from parent draft)
//   onTagsChange      — called with the new array whenever tags change
//   isEditing         — show edit UI vs read-only badges
//   allTags           — full tag list for autocomplete suggestions
//   onCurrentInputChange — called whenever the uncommitted text input changes
//                          (parent uses it for dirty-checking and final-save inclusion)
function TagsField({ tags, onTagsChange, isEditing, allTags, onCurrentInputChange }) {
  const [currentInput, setCurrentInput] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [tagError, setTagError] = useState('');
  const inputRef = useRef(null);

  // Reset input state whenever we leave editing mode.
  useEffect(() => {
    if (!isEditing) {
      setCurrentInput('');
      onCurrentInputChange?.('');
      setSuggestions([]);
      setShowSuggestions(false);
      setTagError('');
    }
  }, [isEditing]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateInput = (val) => {
    setCurrentInput(val);
    onCurrentInputChange?.(val);
  };

  const buildSuggestions = (trimmed, existingTags) =>
    allTags.filter((t) => t.startsWith(trimmed) && !existingTags.includes(t) && t !== trimmed);

  const handleTagInputChange = (value) => {
    if (value.includes(',')) {
      const parts = value.split(',');
      const toCommit = parts.slice(0, -1).map((p) => p.trim().toLowerCase()).filter(Boolean);
      const remaining = parts[parts.length - 1];

      if (toCommit.length > 0) {
        const existing = tags || [];
        const slots = MAX_TAGS - existing.length;
        if (slots <= 0) {
          setTagError(`Maximum ${MAX_TAGS} tags allowed`);
        } else {
          const unique = toCommit.filter((t) => !existing.includes(t)).slice(0, slots);
          if (existing.length + unique.length >= MAX_TAGS) setTagError(`Maximum ${MAX_TAGS} tags allowed`);
          else setTagError('');
          onTagsChange([...existing, ...unique]);
        }
      }

      updateInput(remaining);
      const trimmed = remaining.trim().toLowerCase();
      if (trimmed.length > 0) {
        const existingAfter = [...(tags || []), ...toCommit];
        const sugg = buildSuggestions(trimmed, existingAfter);
        setSuggestions(sugg);
        setShowSuggestions(sugg.length > 0);
      } else {
        setSuggestions([]);
        setShowSuggestions(false);
      }
      return;
    }

    updateInput(value);
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length > 0) {
      const sugg = buildSuggestions(trimmed, tags || []);
      setSuggestions(sugg);
      setShowSuggestions(sugg.length > 0);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  const handleTagKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = currentInput.trim().toLowerCase();
      if (trimmed && !(tags || []).includes(trimmed)) {
        if ((tags || []).length >= MAX_TAGS) {
          setTagError(`Maximum ${MAX_TAGS} tags allowed`);
        } else {
          onTagsChange([...(tags || []), trimmed]);
          setTagError('');
        }
      }
      updateInput('');
      setSuggestions([]);
      setShowSuggestions(false);
    } else if (e.key === 'Backspace' && currentInput === '') {
      if ((tags || []).length > 0) {
        onTagsChange((tags || []).slice(0, -1));
      }
    }
  };

  const removeTag = (tag) => {
    onTagsChange((tags || []).filter((t) => t !== tag));
    setTagError('');
  };

  const selectTagSuggestion = (tag) => {
    if (!(tags || []).includes(tag)) {
      if ((tags || []).length >= MAX_TAGS) {
        setTagError(`Maximum ${MAX_TAGS} tags allowed`);
        return;
      }
      onTagsChange([...(tags || []), tag]);
      setTagError('');
    }
    updateInput('');
    setSuggestions([]);
    setShowSuggestions(false);
    inputRef.current?.focus();
  };

  return (
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
              onClick={() => inputRef.current?.focus()}
            >
              {(tags || []).map((t) => (
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
                ref={inputRef}
                type="text"
                value={currentInput}
                onChange={(e) => handleTagInputChange(e.target.value)}
                onKeyDown={handleTagKeyDown}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                placeholder={(tags || []).length === 0 ? 'Add tags...' : ''}
                maxLength={TAG_MAX}
                style={{ border: 'none', outline: 'none', flex: '1', minWidth: '80px', padding: '0', background: 'transparent' }}
              />
            </div>
            {showSuggestions && (
              <ul className="dropdown-menu show position-absolute w-100 mt-1" style={{ zIndex: 1000, maxHeight: 200, overflowY: 'auto' }}>
                {suggestions.slice(0, 8).map((t) => (
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
            {(tags || []).length > 0 && (
              <span className={`small ${(tags || []).length >= MAX_TAGS ? 'text-danger' : 'text-muted'}`}>
                {(tags || []).length} / {MAX_TAGS} tags
              </span>
            )}
          </div>
        </>
      ) : (
        <div>
          {(tags || []).map((t) => (
            <span key={t} className="badge bg-primary me-1">{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export default TagsField;
