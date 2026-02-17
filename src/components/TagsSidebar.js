import React from 'react';

function TagsSidebar({ tags, selectedTag, onSelectTag, mobile, userName, onSettings, onLogout, settingsMode }) {
  return (
    <div
      className={`d-flex flex-column bg-white ${mobile ? 'h-100' : 'h-100 border-end'}`}
    >
      <div className="p-3 border-bottom">
        <h6 className="text-uppercase text-muted mb-0 small fw-bold">
          <i className="bi bi-tags me-1"></i> Tags
        </h6>
      </div>
      <div className="overflow-auto flex-grow-1">
        <div className="list-group list-group-flush">
          <button
            className={`list-group-item list-group-item-action d-flex justify-content-between align-items-center ${
              !settingsMode && selectedTag === null ? 'active' : ''
            }`}
            onClick={() => onSelectTag(null)}
          >
            All
            <i className="bi bi-collection"></i>
          </button>
          {tags.map((tag) => (
            <button
              key={tag}
              className={`list-group-item list-group-item-action d-flex justify-content-between align-items-center ${
                !settingsMode && selectedTag === tag ? 'active' : ''
              }`}
              onClick={() => onSelectTag(tag)}
            >
              {tag}
              <i className="bi bi-tag"></i>
            </button>
          ))}
        </div>
      </div>
      {userName && (
        <div className="border-top p-3 d-flex align-items-center text-muted small">
          <i className="bi bi-person-circle me-2 fs-5"></i>
          <span className="text-truncate flex-grow-1">{userName}</span>
          <button
            className={`btn btn-sm btn-link ms-2 flex-shrink-0 p-1 rounded logout-btn ${settingsMode ? 'text-primary' : 'text-muted'}`}
            onClick={onSettings}
            title="Settings"
          >
            <i className="bi bi-gear"></i>
          </button>
          {onLogout && (
            <button
              className="btn btn-sm btn-link text-muted ms-2 flex-shrink-0 p-1 rounded logout-btn"
              onClick={onLogout}
              title="Log out"
            >
              <i className="bi bi-box-arrow-right"></i>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default TagsSidebar;
