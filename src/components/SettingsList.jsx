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
            left={item.label}
            right={<i className={`bi ${item.icon}`}></i>}
          />
        ))}
      </div>
    </SidebarPanel>
  );
}

export default SettingsList;
