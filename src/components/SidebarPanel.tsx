import type { CSSProperties, MouseEventHandler, ReactNode } from 'react';
import PanelHeader from './PanelHeader';

interface SidebarPanelProps {
  mobile?: boolean;
  headerIcon?: string;
  headerTitle?: ReactNode;
  headerTrailing?: ReactNode;
  headerUppercase?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
}

function SidebarPanel({
  mobile,
  headerIcon,
  headerTitle,
  headerTrailing = null,
  headerUppercase = true,
  children,
  footer = null,
}: SidebarPanelProps) {
  return (
    <div className={`d-flex flex-column bg-white ${mobile ? 'h-100' : 'h-100 border-end'}`}>
      <PanelHeader icon={headerIcon} title={headerTitle} trailing={headerTrailing} uppercase={headerUppercase} />
      <div className="overflow-auto flex-grow-1">{children}</div>
      {footer}
    </div>
  );
}

interface SidebarItemProps {
  active?: boolean;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
  style?: CSSProperties | null;
}

function SidebarItem({
  active,
  disabled = false,
  onClick,
  left,
  right,
  className = '',
  style = null,
}: SidebarItemProps) {
  return (
    <button
      className={`list-group-item list-group-item-action d-flex justify-content-between align-items-center ${active ? 'active' : ''} ${disabled ? 'disabled' : ''} ${className}`}
      style={style ?? undefined}
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
