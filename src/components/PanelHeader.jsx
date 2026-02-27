// Reusable list-panel header. Pass `trailing` for content on the right side.
function PanelHeader({ icon, title, trailing, uppercase = true }) {
  return (
    <div className="px-3 border-bottom d-flex justify-content-between align-items-center" style={{ height: '3.5rem' }}>
      <h6 className={`${uppercase ? 'text-uppercase ' : ''}text-muted mb-0 fw-bold`} style={{ fontSize: '0.88rem' }}>
        {icon && <i className={`bi ${icon} me-1`}></i>}
        {title}
      </h6>
      {trailing}
    </div>
  );
}

export default PanelHeader;
