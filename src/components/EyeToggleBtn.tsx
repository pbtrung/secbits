interface EyeToggleBtnProps {
  visible: boolean;
  onToggle: () => void;
  className?: string;
}

function EyeToggleBtn({ visible, onToggle, className = 'btn btn-outline-secondary' }: EyeToggleBtnProps) {
  return (
    <button type="button" className={className} onClick={onToggle}>
      <i className={`bi ${visible ? 'bi-eye-slash' : 'bi-eye'}`}></i>
    </button>
  );
}

export default EyeToggleBtn;
