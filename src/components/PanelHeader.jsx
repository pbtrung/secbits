// Reusable list-panel header. Pass `trailing` for content on the right side.
function PanelHeader({ icon, title, trailing }) {
  return (
    <div className="p-3 border-bottom d-flex justify-content-between align-items-center">
      <h6 className="text-uppercase text-muted mb-0 small fw-bold">
        {icon && <i className={`bi ${icon} me-1`}></i>}
        {title}
      </h6>
      {trailing}
    </div>
  );
}

export default PanelHeader;
