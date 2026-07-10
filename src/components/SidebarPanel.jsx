import PanelHeader from './PanelHeader';

function SidebarPanel({
  mobile,
  headerIcon,
  headerTitle,
  headerTrailing = null,
  headerUppercase = true,
  children,
  footer = null,
}) {
  return (
    <div className={`d-flex flex-column bg-white ${mobile ? 'h-100' : 'h-100 border-end'}`}>
      <PanelHeader icon={headerIcon} title={headerTitle} trailing={headerTrailing} uppercase={headerUppercase} />
      <div className="overflow-auto flex-grow-1">{children}</div>
      {footer}
    </div>
  );
}

function SidebarItem({ active, disabled = false, onClick, left, right, className = '', style = null }) {
  return (
    <button
      className={`list-group-item list-group-item-action d-flex justify-content-between align-items-center ${active ? 'active' : ''} ${disabled ? 'disabled' : ''} ${className}`}
      style={style}
      onClick={onClick}
      disabled={disabled}
    >
      {left}
      {right}
    </button>
  );
}

export { SidebarItem };
export default SidebarPanel;
