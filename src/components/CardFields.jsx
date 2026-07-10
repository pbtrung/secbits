import CopyBtn from './CopyBtn';
import EyeToggleBtn from './EyeToggleBtn';
import FieldSection from './FieldSection';
import {
  CARD_HOLDER_MAX, CARD_NUMBER_MAX, CARD_EXPIRY_MAX, CARD_CVV_MAX,
} from '../lib/limits.js';

function MaskedReadOnlyField({ value, visible, onToggle, copied, onCopy, label, style }) {
  return (
    <div className="input-group" style={style}>
      <input
        type={visible ? 'text' : 'password'}
        className="form-control"
        value={value}
        readOnly
      />
      <EyeToggleBtn visible={visible} onToggle={onToggle} />
      <CopyBtn text={value} label={label} copied={copied} onCopy={onCopy} />
    </div>
  );
}

function CardFields({ draft, data, isEditing, visiblePasswords, onToggle, copied, onCopy, onUpdate }) {
  return (
    <>
      <FieldSection icon="bi-person" label="Cardholder Name">
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
      </FieldSection>

      <FieldSection icon="bi-credit-card" label="Card Number">
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
            <EyeToggleBtn visible={visiblePasswords['cardNumber']} onToggle={() => onToggle('cardNumber')} />
          </div>
        ) : (
          <MaskedReadOnlyField
            value={data.cardNumber || ''}
            visible={visiblePasswords['cardNumber']}
            onToggle={() => onToggle('cardNumber')}
            copied={copied}
            onCopy={onCopy}
            label="cardNumber"
          />
        )}
      </FieldSection>

      <FieldSection icon="bi-calendar" label="Expiry">
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
      </FieldSection>

      <FieldSection icon="bi-shield-lock" label="CVV">
        {isEditing ? (
          <div className="input-group" style={{ maxWidth: 180 }}>
            <input
              type={visiblePasswords['cardCvv'] ? 'text' : 'password'}
              className="form-control"
              value={draft.cardCvv || ''}
              onChange={(e) => onUpdate('cardCvv', e.target.value)}
              maxLength={CARD_CVV_MAX}
            />
            <EyeToggleBtn visible={visiblePasswords['cardCvv']} onToggle={() => onToggle('cardCvv')} />
          </div>
        ) : (
          <MaskedReadOnlyField
            value={data.cardCvv || ''}
            visible={visiblePasswords['cardCvv']}
            onToggle={() => onToggle('cardCvv')}
            copied={copied}
            onCopy={onCopy}
            label="cardCvv"
            style={{ maxWidth: 180 }}
          />
        )}
      </FieldSection>
    </>
  );
}

export default CardFields;
