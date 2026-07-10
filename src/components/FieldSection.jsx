function SectionLabel({ icon, children, className = 'form-label text-muted small fw-semibold' }) {
  return (
    <label className={className}>
      {icon && <i className={`bi ${icon} me-1`}></i>}
      {children}
    </label>
  );
}

function FieldSection({ icon, label, className = 'mb-3', children }) {
  return (
    <div className={className}>
      <SectionLabel icon={icon}>{label}</SectionLabel>
      {children}
    </div>
  );
}

export { SectionLabel };
export default FieldSection;
