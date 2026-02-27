// Button that shows a spinner + busyLabel while busy, icon + children when idle.
// All extra props (className, disabled, onClick, …) are forwarded to <button>.
function SpinnerBtn({ busy, busyLabel, icon, children, ...props }) {
  return (
    <button type="button" {...props} disabled={props.disabled || busy}>
      {busy ? (
        <><span className="spinner-border spinner-border-sm me-1"></span>{busyLabel}</>
      ) : icon ? (
        <><i className={`bi ${icon} me-1`}></i>{children}</>
      ) : (
        children
      )}
    </button>
  );
}

export default SpinnerBtn;
