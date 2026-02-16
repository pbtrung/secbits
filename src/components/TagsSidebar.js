import React from 'react';

function TagsSidebar({ tags, selectedTag, onSelectTag }) {
  return (
    <div
      className="d-flex flex-column bg-white border-end"
      style={{ width: 200, minWidth: 200 }}
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
    </div>
  );
}

export default TagsSidebar;
