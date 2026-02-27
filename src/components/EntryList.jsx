import { useState, useEffect, useRef } from 'react';
import SidebarPanel from './SidebarPanel';
import { formatDeletedLabel, ENTRY_TYPES, ENTRY_TYPE_META } from '../entryUtils.js';

function EntryList({ entries, selectedEntryId, onSelectEntry, onNewEntry, selectedTag, trashMode = false, mobile }) {
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    if (!typeDropdownOpen) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setTypeDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [typeDropdownOpen]);

  const newEntryButton = !trashMode && (
    <div className="dropdown" ref={dropdownRef}>
      <button
        className="btn btn-sm btn-primary"
        onClick={() => setTypeDropdownOpen((v) => !v)}
        title="New Entry"
      >
        <i className="bi bi-plus-lg"></i>
      </button>
      {typeDropdownOpen && (
        <ul className="dropdown-menu dropdown-menu-end show mt-1">
          {ENTRY_TYPES.map(({ type, icon, label }) => (
            <li key={type}>
              <button
                className="dropdown-item"
                onClick={() => { setTypeDropdownOpen(false); onNewEntry(type); }}
              >
                <i className={`bi ${icon} me-2`}></i>{label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <SidebarPanel
      mobile={mobile}
      headerIcon={trashMode ? 'bi-trash' : 'bi-key'}
      headerTitle={trashMode ? 'Deleted Entries' : (selectedTag ? `#${selectedTag}` : 'All Entries')}
      headerTrailing={newEntryButton}
    >
      {entries.length === 0 ? (
        <div className="text-muted text-center p-4 small">{trashMode ? 'Trash is empty' : 'No entries found'}</div>
      ) : (
        <div className="list-group list-group-flush">
          {entries.map((entry) => (
            <button
              key={entry.id}
              className={`list-group-item list-group-item-action px-3 d-flex flex-column justify-content-center ${
                selectedEntryId === entry.id ? 'active' : ''
              }`}
              style={{ minHeight: '5rem' }}
              onClick={() => onSelectEntry(entry.id)}
            >
              <div className="fw-semibold text-truncate">
                {ENTRY_TYPE_META[entry.type] && (
                  <i className={`bi ${ENTRY_TYPE_META[entry.type].icon} me-1 fw-normal opacity-75`}></i>
                )}
                {entry.title || <span className="fst-italic text-muted">Untitled</span>}
              </div>
              <small className={`text-truncate d-block ${selectedEntryId === entry.id ? 'text-light' : 'text-muted'}`}>
                {trashMode ? (
                  (() => {
                    const label = formatDeletedLabel(entry.deletedAt);
                    return <span title={label.exact}>{label.text}</span>;
                  })()
                ) : entry.username}
              </small>
              <div>
                {entry.tags.map((t) => (
                  <span
                    key={t}
                    className={`badge me-1 ${
                      selectedEntryId === entry.id ? 'bg-light text-primary' : 'bg-secondary-subtle text-secondary'
                    }`}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </SidebarPanel>
  );
}

export default EntryList;
