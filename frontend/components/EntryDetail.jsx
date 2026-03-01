import { useEffect, useRef, useState } from 'react';
import HistoryDiffModal from './HistoryDiffModal';
import LoginFields from './LoginFields';
import CardFields from './CardFields';
import NotesField from './NotesField';
import TagsField from './TagsField';
import SpinnerBtn from './SpinnerBtn';
import { isHttpUrl } from '../validation.js';
import { formatDeletedLabel, ENTRY_TYPE_META } from '../entryUtils.js';
import {
  TITLE_MAX,
  TAG_MAX,
  USERNAME_MAX,
  PASSWORD_MAX,
  URL_MAX,
  TOTP_SECRET_MAX,
  CUSTOM_FIELD_LABEL_MAX,
  CUSTOM_FIELD_VALUE_MAX,
  CARD_HOLDER_MAX,
  CARD_NUMBER_MAX,
  CARD_EXPIRY_MAX,
  CARD_CVV_MAX,
} from '../limits.js';

function normalizeEntryForDraft(entry) {
  const safe = entry && typeof entry === 'object' ? entry : {};
  return {
    ...safe,
    urls: Array.isArray(safe.urls) ? safe.urls : [],
    totpSecrets: Array.isArray(safe.totpSecrets) ? safe.totpSecrets : [],
    customFields: Array.isArray(safe.customFields) ? safe.customFields : [],
    tags: Array.isArray(safe.tags) ? safe.tags : [],
    cardholderName: typeof safe.cardholderName === 'string' ? safe.cardholderName : '',
    cardNumber: typeof safe.cardNumber === 'string' ? safe.cardNumber : '',
    expiry: typeof safe.expiry === 'string' ? safe.expiry : '',
    cvv: typeof safe.cvv === 'string' ? safe.cvv : '',
  };
}

function hasDraftChanges(draft, entry, tagCurrentInput) {
  const normalizeText = (value) => (typeof value === 'string' ? value : '');
  const normalizeArray = (value) => (Array.isArray(value) ? value : []);

  const pendingTag = tagCurrentInput.trim().toLowerCase();
  const draftTags = normalizeArray(draft?.tags);
  const tagsNow = pendingTag && !draftTags.includes(pendingTag)
    ? [...draftTags, pendingTag]
    : draftTags;

  const originalTags = normalizeArray(entry?.tags);

  return (
    normalizeText(draft?.title) !== normalizeText(entry?.title) ||
    normalizeText(draft?.username) !== normalizeText(entry?.username) ||
    normalizeText(draft?.password) !== normalizeText(entry?.password) ||
    normalizeText(draft?.notes) !== normalizeText(entry?.notes) ||
    normalizeText(draft?.cardholderName) !== normalizeText(entry?.cardholderName) ||
    normalizeText(draft?.cardNumber) !== normalizeText(entry?.cardNumber) ||
    normalizeText(draft?.expiry) !== normalizeText(entry?.expiry) ||
    normalizeText(draft?.cvv) !== normalizeText(entry?.cvv) ||
    JSON.stringify(normalizeArray(draft?.urls)) !== JSON.stringify(normalizeArray(entry?.urls)) ||
    JSON.stringify(normalizeArray(draft?.totpSecrets)) !== JSON.stringify(normalizeArray(entry?.totpSecrets)) ||
    JSON.stringify(normalizeArray(draft?.customFields)) !== JSON.stringify(normalizeArray(entry?.customFields)) ||
    [...tagsNow].sort().join(',') !== [...originalTags].sort().join(',')
  );
}

function replaceAt(list, index, value) {
  const next = [...list];
  next[index] = value;
  return next;
}

function removeAt(list, index) {
  return list.filter((_, i) => i !== index);
}

function shiftIndexedErrors(errors, removedIndex) {
  const next = {};
  Object.entries(errors).forEach(([key, value]) => {
    const idx = Number(key);
    if (idx < removedIndex) next[idx] = value;
    else if (idx > removedIndex) next[idx - 1] = value;
  });
  return next;
}

function getUrlError(value) {
  if (!value) return null;
  if (value.length > URL_MAX) return `URL must be ${URL_MAX} characters or fewer`;
  return isHttpUrl(value) ? null : 'Invalid URL - must start with https:// or http://';
}

function getTotpError(value) {
  if (value.length > TOTP_SECRET_MAX) return `TOTP secret must be ${TOTP_SECRET_MAX} characters or fewer`;
  const cleaned = value.replace(/[\s=_-]+/g, '').toUpperCase();
  if (cleaned.length > 0 && !/^[A-Z2-7]+$/.test(cleaned)) {
    return 'Invalid base32 - only A-Z and 2-7';
  }
  return null;
}

function collectIndexedErrors(values, validator) {
  return values.reduce((acc, value, index) => {
    const error = validator(value);
    if (error) acc[index] = error;
    return acc;
  }, {});
}

function EntryDetail({
  entry,
  isEditing,
  onEdit,
  onSave,
  onDelete,
  onCancel,
  onRestore,
  onRestoreEntry,
  isTrashView = false,
  saving,
  deleting,
  allTags = [],
  onDirtyChange,
  isMobile = false,
}) {
  const [draft, setDraft] = useState(() => normalizeEntryForDraft(entry));
  const [visiblePasswords, setVisiblePasswords] = useState({});
  const [copied, setCopied] = useState(null);
  const [tagCurrentInput, setTagCurrentInput] = useState('');
  const [totpErrors, setTotpErrors] = useState({});
  const [urlErrors, setUrlErrors] = useState({});
  const [notesVisible, setNotesVisible] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyIdx, setHistoryIdx] = useState(0);
  const notesHideTimerRef = useRef(null);

  const commits = entry._commits || [];

  useEffect(() => {
    setDraft(normalizeEntryForDraft(entry));
    setVisiblePasswords({});
    setTagCurrentInput('');
    setNotesVisible(false);
    setTotpErrors({});
    setUrlErrors({});
    setShowHistory(false);
    setHistoryIdx(0);
  }, [entry]);

  useEffect(() => {
    if (isEditing) {
      setDraft(normalizeEntryForDraft(entry));
      setTagCurrentInput('');
    }
  }, [isEditing, entry]);

  useEffect(() => {
    if (!onDirtyChange || !isEditing) {
      onDirtyChange?.(false);
      return;
    }
    onDirtyChange(hasDraftChanges(draft, entry, tagCurrentInput));
  }, [draft, entry, isEditing, onDirtyChange, tagCurrentInput]);

  useEffect(() => {
    const clearClipboard = () => navigator.clipboard.writeText('').catch(() => {});
    const onBlur = () => {
      setNotesVisible(false);
      clearClipboard();
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        setNotesVisible(false);
        clearClipboard();
      }
    };

    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (isEditing) setNotesVisible(false);
  }, [isEditing]);

  useEffect(() => {
    if (!notesVisible) {
      if (notesHideTimerRef.current) {
        clearTimeout(notesHideTimerRef.current);
        notesHideTimerRef.current = null;
      }
      return;
    }

    notesHideTimerRef.current = setTimeout(() => {
      setNotesVisible(false);
      notesHideTimerRef.current = null;
    }, 15000);

    return () => {
      if (notesHideTimerRef.current) {
        clearTimeout(notesHideTimerRef.current);
        notesHideTimerRef.current = null;
      }
    };
  }, [notesVisible]);

  useEffect(() => {
    if (!showHistory) return;
    const handler = (event) => {
      if (event.key === 'Escape' && !saving) {
        setShowHistory(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showHistory, saving]);

  const toggleVisibility = (key) => {
    setVisiblePasswords((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
    setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30000);
  };

  const updateDraft = (field, value) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  const updateUrl = (index, value) => {
    setDraft((prev) => ({ ...prev, urls: replaceAt(prev.urls, index, value) }));
  };

  const addUrl = () => setDraft((prev) => ({ ...prev, urls: [...prev.urls, ''] }));

  const removeUrl = (index) => {
    setDraft((prev) => ({ ...prev, urls: removeAt(prev.urls, index) }));
    setUrlErrors((prev) => shiftIndexedErrors(prev, index));
  };

  const addTotpSecret = () => setDraft((prev) => ({ ...prev, totpSecrets: [...prev.totpSecrets, ''] }));

  const updateTotpSecret = (index, value) => {
    setDraft((prev) => ({ ...prev, totpSecrets: replaceAt(prev.totpSecrets, index, value) }));
  };

  const removeTotpSecret = (index) => {
    setDraft((prev) => ({ ...prev, totpSecrets: removeAt(prev.totpSecrets, index) }));
    setTotpErrors((prev) => shiftIndexedErrors(prev, index));
  };

  const validateTotpSecret = (index, value) => {
    setTotpErrors((prev) => ({ ...prev, [index]: getTotpError(value) }));
  };

  const addCustomField = () => {
    const maxId = draft.customFields.reduce((max, field) => (Number.isFinite(field.id) ? Math.max(max, field.id) : max), 0);
    setDraft((prev) => ({
      ...prev,
      customFields: [...prev.customFields, { id: maxId + 1, label: '', value: '' }],
    }));
  };

  const updateCustomField = (id, key, value) => {
    setDraft((prev) => ({
      ...prev,
      customFields: prev.customFields.map((field) => (field.id === id ? { ...field, [key]: value } : field)),
    }));
  };

  const removeCustomField = (id) => {
    setDraft((prev) => ({ ...prev, customFields: prev.customFields.filter((field) => field.id !== id) }));
  };

  const validateUrl = (index, value) => {
    const error = getUrlError(value);
    if (!error) {
      setUrlErrors((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      return;
    }
    setUrlErrors((prev) => ({ ...prev, [index]: error }));
  };

  const handleSave = () => {
    const freshUrlErrors = collectIndexedErrors(draft.urls, getUrlError);
    const freshTotpErrors = collectIndexedErrors(draft.totpSecrets, getTotpError);

    setUrlErrors(freshUrlErrors);
    setTotpErrors(freshTotpErrors);

    if (Object.keys(freshUrlErrors).length > 0 || Object.keys(freshTotpErrors).length > 0) {
      return;
    }

    const finalTags = [...(draft.tags || [])];
    const pendingTag = tagCurrentInput.trim().toLowerCase();
    if (pendingTag && !finalTags.includes(pendingTag)) {
      finalTags.push(pendingTag);
    }

    onSave({ ...draft, tags: finalTags, urls: draft.urls.filter((url) => url.trim()) });
  };

  const handleDelete = () => {
    const message = isTrashView
      ? `Permanently delete "${entry.title || 'this entry'}"? This cannot be undone.`
      : `Delete "${entry.title || 'this entry'}"?`;

    if (window.confirm(message)) {
      onDelete(entry.id);
    }
  };

  const handleRestoreFromModal = async (commitHash) => {
    if (!onRestore) return;
    const restored = await onRestore(entry.id, commitHash);
    if (restored) setShowHistory(false);
  };

  const isNote = entry.type === 'note';
  const isCard = entry.type === 'card';
  const isLogin = !isNote && !isCard;

  const hasInvalidFields =
    draft.title.length > TITLE_MAX ||
    draft.tags.some((tag) => tag.length > TAG_MAX) ||
    (isLogin && (
      Object.values(totpErrors).some(Boolean) ||
      Object.values(urlErrors).some(Boolean) ||
      draft.username.length > USERNAME_MAX ||
      draft.password.length > PASSWORD_MAX ||
      draft.urls.some((url) => url.length > URL_MAX) ||
      draft.totpSecrets.some((secret) => secret.length > TOTP_SECRET_MAX) ||
      draft.customFields.some((field) => field.label.length > CUSTOM_FIELD_LABEL_MAX || field.value.length > CUSTOM_FIELD_VALUE_MAX)
    )) ||
    (isCard && (
      (draft.cardholderName?.length || 0) > CARD_HOLDER_MAX ||
      (draft.cardNumber?.length || 0) > CARD_NUMBER_MAX ||
      (draft.expiry?.length || 0) > CARD_EXPIRY_MAX ||
      (draft.cvv?.length || 0) > CARD_CVV_MAX
    ));

  const allFieldsEmpty = isNote
    ? !draft.title.trim() && !draft.notes.trim()
    : isCard
      ? !draft.title.trim() && !draft.cardholderName.trim() && !draft.cardNumber.trim() && !draft.expiry.trim() && !draft.cvv.trim() && !draft.notes.trim()
      : !draft.title.trim() && !draft.username.trim() && !draft.password.trim() && !draft.notes.trim() && !draft.urls.some((url) => url.trim()) && draft.totpSecrets.length === 0 && draft.customFields.length === 0;

  const saveDisabled = hasInvalidFields || allFieldsEmpty;
  const data = isEditing ? draft : entry;

  return (
    <>
      <fieldset disabled={saving || deleting} className="p-4" style={{ maxWidth: 700 }}>
        <div className="d-flex justify-content-between align-items-start mb-4">
          <div className="flex-grow-1">
            {isEditing ? (
              <input
                className="form-control form-control-lg fw-bold"
                value={draft.title}
                onChange={(event) => updateDraft('title', event.target.value)}
                placeholder="Entry Title"
                maxLength={TITLE_MAX}
                autoFocus
              />
            ) : (
              <h3 className="fw-bold mb-0">{data.title}</h3>
            )}

            {entry.type && ENTRY_TYPE_META[entry.type] && (
              <div className="small text-muted mt-1">
                <i className={`bi ${ENTRY_TYPE_META[entry.type].icon} me-1`}></i>
                {ENTRY_TYPE_META[entry.type].label}
              </div>
            )}

            {isTrashView && (
              <div className="small text-muted mt-1" title={formatDeletedLabel(entry.deletedAt).exact}>
                <i className="bi bi-trash me-1"></i>
                {formatDeletedLabel(entry.deletedAt).text}
              </div>
            )}
          </div>
        </div>

        {isLogin && (
          <LoginFields
            draft={draft}
            data={data}
            isEditing={isEditing}
            visiblePasswords={visiblePasswords}
            onToggle={toggleVisibility}
            copied={copied}
            onCopy={copyToClipboard}
            onUpdate={updateDraft}
            onAddUrl={addUrl}
            onUpdateUrl={updateUrl}
            onRemoveUrl={removeUrl}
            onValidateUrl={validateUrl}
            urlErrors={urlErrors}
            onAddTotp={addTotpSecret}
            onUpdateTotp={updateTotpSecret}
            onRemoveTotp={removeTotpSecret}
            onValidateTotp={validateTotpSecret}
            totpErrors={totpErrors}
            onAddCustomField={addCustomField}
            onUpdateCustomField={updateCustomField}
            onRemoveCustomField={removeCustomField}
          />
        )}

        {isCard && (
          <CardFields
            draft={draft}
            data={data}
            isEditing={isEditing}
            visiblePasswords={visiblePasswords}
            onToggle={toggleVisibility}
            copied={copied}
            onCopy={copyToClipboard}
            onUpdate={updateDraft}
          />
        )}

        <NotesField
          isEditing={isEditing}
          value={data.notes}
          onChange={(val) => updateDraft('notes', val)}
          visible={notesVisible}
          onToggleVisible={() => setNotesVisible((prev) => !prev)}
        />

        <TagsField
          key={entry.id}
          tags={draft.tags}
          onTagsChange={(newTags) => setDraft((prev) => ({ ...prev, tags: newTags }))}
          isEditing={isEditing}
          allTags={allTags}
          onCurrentInputChange={setTagCurrentInput}
        />

        <div className="d-flex gap-2 align-items-center border-top pt-3 flex-wrap">
          {isTrashView ? (
            <SpinnerBtn
              className="btn btn-success"
              onClick={() => onRestoreEntry?.(entry.id)}
              disabled={saving || deleting}
              busy={saving}
              busyLabel="Restoring..."
              icon="bi-arrow-counterclockwise"
            >
              Restore
            </SpinnerBtn>
          ) : isEditing ? (
            <>
              <SpinnerBtn
                className="btn btn-success"
                onClick={handleSave}
                disabled={saveDisabled}
                busy={saving}
                busyLabel="Saving..."
                icon="bi-check-lg"
              >
                Save
              </SpinnerBtn>
              <button className="btn btn-secondary" onClick={onCancel}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={() => onEdit(entry.id)}>
              <i className="bi bi-pencil me-1"></i>Edit
            </button>
          )}

          {commits.length > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              onClick={() => {
                setHistoryIdx(0);
                setShowHistory(true);
              }}
            >
              <i className="bi bi-git me-1"></i>
              {commits.length} version{commits.length !== 1 ? 's' : ''}
            </button>
          )}

          {isTrashView && (
            <SpinnerBtn
              className="btn btn-danger ms-auto"
              onClick={handleDelete}
              disabled={saving || deleting}
              busy={deleting}
              busyLabel="Deleting..."
              icon="bi-trash"
            >
              Delete
            </SpinnerBtn>
          )}

          {!entry._isNew && !isTrashView && (
            <SpinnerBtn
              className="btn btn-outline-danger ms-auto"
              onClick={handleDelete}
              busy={deleting}
              busyLabel="Deleting..."
              icon="bi-trash"
            >
              Delete
            </SpinnerBtn>
          )}
        </div>
      </fieldset>

      {showHistory && (
        <HistoryDiffModal
          commits={commits}
          idx={historyIdx}
          onIdxChange={setHistoryIdx}
          onRestore={handleRestoreFromModal}
          onClose={() => {
            if (!saving) setShowHistory(false);
          }}
          saving={saving}
          isMobile={isMobile}
          canRestore={!isTrashView}
        />
      )}
    </>
  );
}

export default EntryDetail;
