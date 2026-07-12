interface CopyBtnProps {
  text: string;
  label: string;
  copied: string | null;
  onCopy: (text: string, label: string) => void;
}

function CopyBtn({ text, label, copied, onCopy }: CopyBtnProps) {
  return (
    <button className="btn btn-sm btn-outline-secondary" onClick={() => onCopy(text, label)} title="Copy">
      <i className={`bi ${copied === label ? 'bi-check-lg text-success' : 'bi-clipboard'}`}></i>
    </button>
  );
}

export default CopyBtn;
