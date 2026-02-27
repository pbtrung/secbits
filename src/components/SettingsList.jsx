import SidebarPanel, { SidebarItem } from './SidebarPanel';

function SettingsList({ selectedPage, onSelectPage, mobile }) {
  const items = [
    { id: 'export', label: 'Export', icon: 'bi-download' },
    { id: 'security', label: 'Security', icon: 'bi-shield-lock' },
    { id: 'about', label: 'About', icon: 'bi-info-circle' },
  ];

  return (
    <SidebarPanel mobile={mobile} headerIcon="bi-gear" headerTitle="Settings">
      <div className="list-group list-group-flush">
        {items.map((item) => (
          <SidebarItem
            key={item.id}
            active={selectedPage === item.id}
            onClick={() => onSelectPage(item.id)}
            style={{ height: '2.5rem' }}
            left={<span><i className={`bi ${item.icon} me-2`}></i>{item.label}</span>}
            right={null}
          />
        ))}
      </div>
    </SidebarPanel>
  );
}

export default SettingsList;
