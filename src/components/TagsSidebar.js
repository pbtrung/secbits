import React from 'react';

function TagsSidebar({ tags, selectedTag, onSelectTag, mobile, userName }) {
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
              selectedTag === null ? 'active' : ''
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
                selectedTag === tag ? 'active' : ''
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
          <span className="text-truncate">{userName}</span>
        </div>
      )}
    </div>
  );
}

export default TagsSidebar;
