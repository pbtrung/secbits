function EntryList({ entries, selectedEntryId, onSelectEntry, onNewEntry, selectedTag, mobile }) {
  return (
    <div
      className={`d-flex flex-column bg-white ${mobile ? 'h-100' : 'h-100 border-end'}`}
    >
      <div className="p-3 border-bottom d-flex justify-content-between align-items-center">
        <h6 className="text-uppercase text-muted mb-0 small fw-bold">
          <i className="bi bi-key me-1"></i>
          {selectedTag ? `#${selectedTag}` : 'All Entries'}
        </h6>
        <button
          className="btn btn-sm btn-primary"
          onClick={onNewEntry}
          title="New Entry"
        >
          <i className="bi bi-plus-lg"></i>
        </button>
      </div>
      <div className="overflow-auto flex-grow-1">
        {entries.length === 0 ? (
          <div className="text-muted text-center p-4 small">No entries found</div>
        ) : (
          <div className="list-group list-group-flush">
            {entries.map((entry) => (
              <button
                key={entry.id}
                className={`list-group-item list-group-item-action py-3 ${
                  selectedEntryId === entry.id ? 'active' : ''
                }`}
                onClick={() => onSelectEntry(entry.id)}
              >
                <div className="fw-semibold text-truncate">
                  {entry.title || <span className="fst-italic text-muted">Untitled</span>}
                </div>
                <small className={`text-truncate d-block ${selectedEntryId === entry.id ? 'text-light' : 'text-muted'}`}>
                  {entry.username}
                </small>
                <div className="mt-1">
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
      </div>
    </div>
  );
}

export default EntryList;
