import SidebarPanel, { SidebarItem } from './SidebarPanel';

function TagsSidebar({
  tags,
  allCount = 0,
  tagCounts = {},
  selectedTag,
  onSelectTag,
  onOpenTrash,
  trashCount = 0,
  trashMode = false,
  mobile,
  userName,
  onSettings,
  onLogout,
  settingsMode,
}) {
  const footer = userName && (
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
  );

  return (
    <SidebarPanel mobile={mobile} headerIcon="bi-funnel" headerTitle="Browse" footer={footer}>
      <div className="list-group list-group-flush">
        <SidebarItem
          active={!settingsMode && !trashMode && selectedTag === null}
          onClick={() => onSelectTag(null)}
          style={{ height: '2.5rem' }}
          left={<span><i className="bi bi-collection me-2"></i>All</span>}
          right={<span className="badge rounded-pill text-bg-light">{allCount}</span>}
        />
        {tags.map((tag) => (
          <SidebarItem
            key={tag}
            active={!settingsMode && !trashMode && selectedTag === tag}
            onClick={() => onSelectTag(tag)}
            style={{ height: '2.5rem' }}
            left={<span className="text-truncate me-2 ps-3"><i className="bi bi-tag me-2"></i>{tag}</span>}
            right={<span className="badge rounded-pill text-bg-light">{tagCounts[tag] || 0}</span>}
          />
        ))}
        <SidebarItem
          active={!settingsMode && trashMode}
          disabled={trashCount === 0}
          onClick={onOpenTrash}
          style={{ height: '2.5rem' }}
          left={<span><i className="bi bi-trash me-2"></i>Trash</span>}
          right={<span className="badge rounded-pill text-bg-light">{trashCount}</span>}
        />
      </div>
    </SidebarPanel>
  );
}

export default TagsSidebar;
