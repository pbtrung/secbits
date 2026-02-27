import PanelHeader from './PanelHeader';

function SettingsList({ selectedPage, onSelectPage, mobile }) {
  const items = [
    { id: 'export', label: 'Export', icon: 'bi-download' },
    { id: 'security', label: 'Security', icon: 'bi-shield-lock' },
    { id: 'about', label: 'About', icon: 'bi-info-circle' },
  ];

  return (
    <div className={`d-flex flex-column bg-white ${mobile ? 'h-100' : 'h-100 border-end'}`}>
      <PanelHeader icon="bi-gear" title="Settings" />
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
