function EyeToggleBtn({ visible, onToggle, className = 'btn btn-outline-secondary' }) {
  return (
    <button type="button" className={className} onClick={onToggle}>
      <i className={`bi ${visible ? 'bi-eye-slash' : 'bi-eye'}`}></i>
    </button>
  );
}

export default EyeToggleBtn;
