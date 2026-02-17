import React from 'react';

function SettingsList({ selectedPage, onSelectPage, mobile }) {
  const items = [
    { id: 'export', label: 'Export', icon: 'bi-download' },
    { id: 'about', label: 'About', icon: 'bi-info-circle' },
  ];

  return (
    <div className={`d-flex flex-column bg-white ${mobile ? 'h-100' : 'h-100 border-end'}`}>
      <div className="p-3 border-bottom">
        <h6 className="text-uppercase text-muted mb-0 small fw-bold">
          <i className="bi bi-gear me-1"></i> Settings
        </h6>
      </div>
      <div className="overflow-auto flex-grow-1">
        <div className="list-group list-group-flush">
          {items.map((item) => (
            <button
              key={item.id}
              className={`list-group-item list-group-item-action d-flex justify-content-between align-items-center ${
                selectedPage === item.id ? 'active' : ''
              }`}
              onClick={() => onSelectPage(item.id)}
            >
              {item.label}
              <i className={`bi ${item.icon}`}></i>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default SettingsList;
