import type { ReactNode } from 'react';

interface SectionLabelProps {
  icon?: string;
  children?: ReactNode;
  className?: string;
}

function SectionLabel({ icon, children, className = 'form-label text-muted small fw-semibold' }: SectionLabelProps) {
  return (
    <label className={className}>
      {icon && <i className={`bi ${icon} me-1`}></i>}
      {children}
    </label>
  );
}

interface FieldSectionProps {
  icon?: string;
  label?: ReactNode;
  className?: string;
  children?: ReactNode;
}

function FieldSection({ icon, label, className = 'mb-3', children }: FieldSectionProps) {
  return (
    <div className={className}>
      <SectionLabel icon={icon}>{label}</SectionLabel>
      {children}
    </div>
  );
}

export { SectionLabel };
export default FieldSection;
