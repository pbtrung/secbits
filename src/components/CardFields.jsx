import CopyBtn from './CopyBtn';
import {
  CARD_HOLDER_MAX, CARD_NUMBER_MAX, CARD_EXPIRY_MAX, CARD_CVV_MAX,
} from '../limits.js';

function CardFields({ draft, data, isEditing, visiblePasswords, onToggle, copied, onCopy, onUpdate }) {
  return (
    <>
      {/* Cardholder Name */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-person me-1"></i> Cardholder Name
        </label>
        {isEditing ? (
          <input
            className="form-control"
            value={draft.cardholderName || ''}
            onChange={(e) => onUpdate('cardholderName', e.target.value)}
            maxLength={CARD_HOLDER_MAX}
          />
        ) : (
          <div className="input-group">
            <input className="form-control" value={data.cardholderName || ''} readOnly />
            <CopyBtn text={data.cardholderName || ''} label="cardholderName" copied={copied} onCopy={onCopy} />
          </div>
        )}
      </div>

      {/* Card Number */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-credit-card me-1"></i> Card Number
        </label>
        {isEditing ? (
          <div className="input-group">
            <input
              type={visiblePasswords['cardNumber'] ? 'text' : 'password'}
              className="form-control"
              value={draft.cardNumber || ''}
              onChange={(e) => onUpdate('cardNumber', e.target.value)}
              maxLength={CARD_NUMBER_MAX}
              placeholder="•••• •••• •••• ••••"
            />
            <button className="btn btn-outline-secondary" onClick={() => onToggle('cardNumber')}>
              <i className={`bi ${visiblePasswords['cardNumber'] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
            </button>
          </div>
        ) : (
          <div className="input-group">
            <input
              type={visiblePasswords['cardNumber'] ? 'text' : 'password'}
              className="form-control"
              value={data.cardNumber || ''}
              readOnly
            />
            <button className="btn btn-outline-secondary" onClick={() => onToggle('cardNumber')}>
              <i className={`bi ${visiblePasswords['cardNumber'] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
            </button>
            <CopyBtn text={data.cardNumber || ''} label="cardNumber" copied={copied} onCopy={onCopy} />
          </div>
        )}
      </div>

      {/* Expiry */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-calendar me-1"></i> Expiry
        </label>
        {isEditing ? (
          <input
            className="form-control"
            value={draft.cardExpiry || ''}
            onChange={(e) => onUpdate('cardExpiry', e.target.value)}
            maxLength={CARD_EXPIRY_MAX}
            placeholder="MM/YY"
            style={{ maxWidth: 120 }}
          />
        ) : (
          <div className="input-group" style={{ maxWidth: 180 }}>
            <input className="form-control" value={data.cardExpiry || ''} readOnly />
            <CopyBtn text={data.cardExpiry || ''} label="cardExpiry" copied={copied} onCopy={onCopy} />
          </div>
        )}
      </div>

      {/* CVV */}
      <div className="mb-3">
        <label className="form-label text-muted small fw-semibold">
          <i className="bi bi-shield-lock me-1"></i> CVV
        </label>
        {isEditing ? (
          <div className="input-group" style={{ maxWidth: 180 }}>
            <input
              type={visiblePasswords['cardCvv'] ? 'text' : 'password'}
              className="form-control"
              value={draft.cardCvv || ''}
              onChange={(e) => onUpdate('cardCvv', e.target.value)}
              maxLength={CARD_CVV_MAX}
            />
            <button className="btn btn-outline-secondary" onClick={() => onToggle('cardCvv')}>
              <i className={`bi ${visiblePasswords['cardCvv'] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
            </button>
          </div>
        ) : (
          <div className="input-group" style={{ maxWidth: 180 }}>
            <input
              type={visiblePasswords['cardCvv'] ? 'text' : 'password'}
              className="form-control"
              value={data.cardCvv || ''}
              readOnly
            />
            <button className="btn btn-outline-secondary" onClick={() => onToggle('cardCvv')}>
              <i className={`bi ${visiblePasswords['cardCvv'] ? 'bi-eye-slash' : 'bi-eye'}`}></i>
            </button>
            <CopyBtn text={data.cardCvv || ''} label="cardCvv" copied={copied} onCopy={onCopy} />
          </div>
        )}
      </div>
    </>
  );
}

export default CardFields;
