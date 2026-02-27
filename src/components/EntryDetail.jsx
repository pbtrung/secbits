import { useState, useEffect, useRef } from 'react';
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
  USERNAME_MAX, PASSWORD_MAX,
  URL_MAX, TOTP_SECRET_MAX,
  CUSTOM_FIELD_LABEL_MAX, CUSTOM_FIELD_VALUE_MAX,
  CARD_HOLDER_MAX, CARD_NUMBER_MAX, CARD_EXPIRY_MAX, CARD_CVV_MAX,
} from '../limits.js';

function hasDraftChanges(draft, entry, tagCurrentInput) {
  const normalizeText = (value) => (typeof value === 'string' ? value : '');
  const normalizeArray = (value) => (Array.isArray(value) ? value : []);
  const currentTagText = tagCurrentInput.trim().toLowerCase();
  const draftTags = normalizeArray(draft?.tags);
  const tagsNow = (currentTagText && !draftTags.includes(currentTagText))
    ? [...draftTags, currentTagText]
    : draftTags;
  const tagsOrig = normalizeArray(entry?.tags);

  return (
    normalizeText(draft?.title) !== normalizeText(entry?.title) ||
    normalizeText(draft?.username) !== normalizeText(entry?.username) ||
    normalizeText(draft?.password) !== normalizeText(entry?.password) ||
    normalizeText(draft?.notes) !== normalizeText(entry?.notes) ||
    normalizeText(draft?.cardholderName) !== normalizeText(entry?.cardholderName) ||
    normalizeText(draft?.cardNumber) !== normalizeText(entry?.cardNumber) ||
    normalizeText(draft?.cardExpiry) !== normalizeText(entry?.cardExpiry) ||
    normalizeText(draft?.cardCvv) !== normalizeText(entry?.cardCvv) ||
    JSON.stringify(normalizeArray(draft?.urls)) !== JSON.stringify(normalizeArray(entry?.urls)) ||
    JSON.stringify(normalizeArray(draft?.totpSecrets)) !== JSON.stringify(normalizeArray(entry?.totpSecrets)) ||
    JSON.stringify(normalizeArray(draft?.customFields)) !== JSON.stringify(normalizeArray(entry?.customFields)) ||
    [...tagsNow].sort().join(',') !== [...tagsOrig].sort().join(',')
  );
}

function normalizeEntryForDraft(entry) {
  const safe = entry && typeof entry === 'object' ? entry : {};
  const result = {
    ...safe,
    urls: Array.isArray(safe.urls) ? safe.urls : [],
    totpSecrets: Array.isArray(safe.totpSecrets) ? safe.totpSecrets : [],
    customFields: Array.isArray(safe.customFields) ? safe.customFields : (Array.isArray(safe.hiddenFields) ? safe.hiddenFields : []),
    tags: Array.isArray(safe.tags) ? safe.tags : [],
  };
  if (safe.type === 'card') {
    result.cardholderName = typeof safe.cardholderName === 'string' ? safe.cardholderName : '';
    result.cardNumber     = typeof safe.cardNumber     === 'string' ? safe.cardNumber     : '';
    result.cardExpiry     = typeof safe.cardExpiry     === 'string' ? safe.cardExpiry     : '';
    result.cardCvv        = typeof safe.cardCvv        === 'string' ? safe.cardCvv        : '';
  }
  return result;
}

// ─── EntryDetail ──────────────────────────────────────────────────────────────

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
  }, [isEditing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!onDirtyChange || !isEditing) {
      onDirtyChange?.(false);
      return;
    }
    onDirtyChange(hasDraftChanges(draft, entry, tagCurrentInput));
  }, [draft, tagCurrentInput, entry, isEditing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const clearClipboard = () => navigator.clipboard.writeText('').catch(() => {});
    const hideNotes = () => setNotesVisible(false);
    const onBlur = () => { hideNotes(); clearClipboard(); };
    const onVisibilityChange = () => {
      if (document.hidden) { hideNotes(); clearClipboard(); }
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
    const handler = (e) => { if (e.key === 'Escape' && !saving) setShowHistory(false); };
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
    setDraft({ ...draft, [field]: value });
  };

  const updateUrl = (index, value) => {
    const urls = [...draft.urls];
    urls[index] = value;
    setDraft({ ...draft, urls });
  };

  const addUrl = () => setDraft({ ...draft, urls: [...draft.urls, ''] });

  const removeUrl = (index) => {
    const urls = draft.urls.filter((_, i) => i !== index);
    setDraft({ ...draft, urls });
    setUrlErrors((prev) => {
      const next = {};
      Object.entries(prev).forEach(([k, v]) => {
        const ki = Number(k);
        if (ki < index) next[ki] = v;
        else if (ki > index) next[ki - 1] = v;
      });
      return next;
    });
  };

  const addTotpSecret = () => setDraft({ ...draft, totpSecrets: [...draft.totpSecrets, ''] });

  const updateTotpSecret = (index, value) => {
    const totpSecrets = [...draft.totpSecrets];
    totpSecrets[index] = value;
    setDraft({ ...draft, totpSecrets });
  };

  const removeTotpSecret = (index) => {
    const totpSecrets = draft.totpSecrets.filter((_, i) => i !== index);
    setDraft({ ...draft, totpSecrets });
    setTotpErrors((prev) => {
      const next = {};
      Object.entries(prev).forEach(([k, v]) => {
        const ki = Number(k);
        if (ki < index) next[ki] = v;
        else if (ki > index) next[ki - 1] = v;
      });
      return next;
    });
  };

  const validateTotpSecret = (index, value) => {
    if (value.length > TOTP_SECRET_MAX) {
      setTotpErrors((prev) => ({ ...prev, [index]: `TOTP secret must be ${TOTP_SECRET_MAX} characters or fewer` }));
      return;
    }
    const cleaned = value.replace(/[\s=_-]+/g, '').toUpperCase();
    const valid = cleaned.length === 0 || /^[A-Z2-7]+$/.test(cleaned);
    setTotpErrors((prev) => ({ ...prev, [index]: valid ? null : 'Invalid base32 — only A–Z and 2–7' }));
  };

  const addHiddenField = () => {
    const maxId = draft.customFields.reduce((max, f) => Number.isFinite(f.id) ? Math.max(max, f.id) : max, 0);
    setDraft({
      ...draft,
      customFields: [...draft.customFields, { id: maxId + 1, label: '', value: '' }],
    });
  };

  const updateHiddenField = (id, key, value) => {
    setDraft({
      ...draft,
      customFields: draft.customFields.map((f) => f.id === id ? { ...f, [key]: value } : f),
    });
  };

  const removeHiddenField = (id) => {
    setDraft({ ...draft, customFields: draft.customFields.filter((f) => f.id !== id) });
  };

  const validateUrl = (index, value) => {
    if (!value) {
      setUrlErrors((prev) => { const next = { ...prev }; delete next[index]; return next; });
      return;
    }
    if (value.length > URL_MAX) {
      setUrlErrors((prev) => ({ ...prev, [index]: `URL must be ${URL_MAX} characters or fewer` }));
      return;
    }
    if (isHttpUrl(value)) {
      setUrlErrors((prev) => { const next = { ...prev }; delete next[index]; return next; });
    } else {
      setUrlErrors((prev) => ({ ...prev, [index]: 'Invalid URL — must start with https:// or http://' }));
    }
  };

  const handleSave = () => {
    const freshUrlErrors = {};
    draft.urls.forEach((url, i) => {
      if (!url) return;
      if (url.length > URL_MAX) {
        freshUrlErrors[i] = `URL must be ${URL_MAX} characters or fewer`;
      } else if (!isHttpUrl(url)) {
        freshUrlErrors[i] = 'Invalid URL — must start with https:// or http://';
      }
    });

    const freshTotpErrors = {};
    draft.totpSecrets.forEach((secret, i) => {
      if (secret.length > TOTP_SECRET_MAX) {
        freshTotpErrors[i] = `TOTP secret must be ${TOTP_SECRET_MAX} characters or fewer`;
        return;
      }
      const cleaned = secret.replace(/[\s=_-]+/g, '').toUpperCase();
      if (cleaned.length > 0 && !/^[A-Z2-7]+$/.test(cleaned)) {
        freshTotpErrors[i] = 'Invalid base32 — only A–Z and 2–7';
      }
    });

    setUrlErrors(freshUrlErrors);
    setTotpErrors(freshTotpErrors);

    if (Object.keys(freshUrlErrors).length > 0 || Object.keys(freshTotpErrors).length > 0) {
      return;
    }

    const finalTags = [...(draft.tags || [])];
    const current = tagCurrentInput.trim().toLowerCase();
    if (current && !finalTags.includes(current)) {
      finalTags.push(current);
    }
    onSave({ ...draft, tags: finalTags, urls: draft.urls.filter((u) => u.trim()) });
  };

  const handleDelete = () => {
    const message = isTrashView
      ? `Permanently delete "${entry.title || 'this entry'}"? This cannot be undone.`
      : `Delete "${entry.title || 'this entry'}"?`;
    if (window.confirm(message)) {
      onDelete(entry.id);
    }
  };

  const handleRestoreEntry = async () => {
    await onRestoreEntry?.(entry.id);
  };

  const handleRestoreFromModal = async (commitHash) => {
    const restored = await onRestore(entry.id, commitHash);
    if (restored) setShowHistory(false);
  };

  const isNote  = entry.type === 'note';
  const isCard  = entry.type === 'card';
  const isLogin = !isNote && !isCard;

  const hasInvalidFields =
    draft.title.length > TITLE_MAX ||
    draft.tags.some((t) => t.length > TAG_MAX) ||
    (isLogin && (
      Object.values(totpErrors).some(Boolean) ||
      Object.values(urlErrors).some(Boolean) ||
      draft.username.length > USERNAME_MAX ||
      draft.password.length > PASSWORD_MAX ||
      draft.urls.some((u) => u.length > URL_MAX) ||
      draft.totpSecrets.some((s) => s.length > TOTP_SECRET_MAX) ||
      draft.customFields.some((f) => f.label.length > CUSTOM_FIELD_LABEL_MAX || f.value.length > CUSTOM_FIELD_VALUE_MAX)
    )) ||
    (isCard && (
      (draft.cardholderName?.length || 0) > CARD_HOLDER_MAX ||
      (draft.cardNumber?.length || 0) > CARD_NUMBER_MAX ||
      (draft.cardExpiry?.length || 0) > CARD_EXPIRY_MAX ||
      (draft.cardCvv?.length || 0) > CARD_CVV_MAX
    ));

  const allFieldsEmpty = isNote
    ? !draft.title.trim() && !draft.notes.trim()
    : isCard
      ? !draft.title.trim() && !draft.cardholderName?.trim() && !draft.cardNumber?.trim() && !draft.cardExpiry?.trim() && !draft.cardCvv?.trim() && !draft.notes.trim()
      : !draft.title.trim() && !draft.username.trim() && !draft.password.trim() && !draft.notes.trim() && !draft.urls.some((u) => u.trim()) && draft.totpSecrets.length === 0 && draft.customFields.length === 0;

  const saveDisabled = hasInvalidFields || allFieldsEmpty;

  const data = isEditing ? draft : entry;

  return (
    <>
    <fieldset disabled={saving || deleting} className="p-4" style={{ maxWidth: 700 }}>
      {/* Title */}
      <div className="d-flex justify-content-between align-items-start mb-4">
        <div className="flex-grow-1">
          {isEditing ? (
            <input
              className="form-control form-control-lg fw-bold"
              value={draft.title}
              onChange={(e) => updateDraft('title', e.target.value)}
              placeholder="Entry Title"
              maxLength={TITLE_MAX}
              autoFocus
            />
          ) : (
            <h3 className="fw-bold mb-0">{data.title}</h3>
          )}
          {isTrashView && (
            <div className="small text-muted mt-1" title={formatDeletedLabel(entry.deletedAt).exact}>
              <i className="bi bi-trash me-1"></i>
              {formatDeletedLabel(entry.deletedAt).text}
            </div>
          )}
          {entry.type && ENTRY_TYPE_META[entry.type] && (
            <div className="small text-muted mt-1">
              <i className={`bi ${ENTRY_TYPE_META[entry.type].icon} me-1`}></i>
              {ENTRY_TYPE_META[entry.type].label}
            </div>
          )}
        </div>
      </div>

      {/* Type-specific fields */}
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
          onAddCustomField={addHiddenField}
          onUpdateCustomField={updateHiddenField}
          onRemoveCustomField={removeHiddenField}
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

      {/* Notes — all types */}
      <NotesField
        isEditing={isEditing}
        value={data.notes}
        onChange={(val) => updateDraft('notes', val)}
        visible={notesVisible}
        onToggleVisible={() => setNotesVisible((v) => !v)}
      />

      {/* Tags — all types */}
      <TagsField
        key={entry.id}
        tags={draft.tags}
        onTagsChange={(newTags) => setDraft((prev) => ({ ...prev, tags: newTags }))}
        isEditing={isEditing}
        allTags={allTags}
        onCurrentInputChange={setTagCurrentInput}
      />

      {/* Action Buttons */}
      <div className="d-flex gap-2 align-items-center border-top pt-3 flex-wrap">
        {isTrashView ? (
          <>
            <SpinnerBtn
              className="btn btn-success"
              onClick={handleRestoreEntry}
              disabled={saving || deleting}
              busy={saving}
              busyLabel="Restoring..."
              icon="bi-arrow-counterclockwise"
            >Restore</SpinnerBtn>
            {commits.length > 0 && (
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={() => { setHistoryIdx(0); setShowHistory(true); }}
              >
                <i className="bi bi-git me-1"></i>
                {commits.length} version{commits.length !== 1 ? 's' : ''}
              </button>
            )}
            <SpinnerBtn
              className="btn btn-danger ms-auto"
              onClick={handleDelete}
              disabled={saving || deleting}
              busy={deleting}
              busyLabel="Deleting..."
              icon="bi-trash"
            >Delete</SpinnerBtn>
          </>
        ) : isEditing ? (
          <>
            <SpinnerBtn
              className="btn btn-success"
              onClick={handleSave}
              disabled={saveDisabled}
              busy={saving}
              busyLabel="Saving..."
              icon="bi-check-lg"
            >Save</SpinnerBtn>
            <button className="btn btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={() => onEdit(entry.id)}>
            <i className="bi bi-pencil me-1"></i>Edit
          </button>
        )}

        {!isTrashView && commits.length > 0 && (
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => { setHistoryIdx(0); setShowHistory(true); }}
          >
            <i className="bi bi-git me-1"></i>
            {commits.length} version{commits.length !== 1 ? 's' : ''}
          </button>
        )}

        {!entry._isNew && !isTrashView && (
          <SpinnerBtn
            className="btn btn-outline-danger ms-auto"
            onClick={handleDelete}
            busy={deleting}
            busyLabel="Deleting..."
            icon="bi-trash"
          >Delete</SpinnerBtn>
        )}
      </div>
    </fieldset>

    {showHistory && (
      <HistoryDiffModal
        commits={commits}
        idx={historyIdx}
        onIdxChange={setHistoryIdx}
        onRestore={handleRestoreFromModal}
        onClose={() => { if (!saving) setShowHistory(false); }}
        saving={saving}
        isMobile={isMobile}
      />
    )}
    </>
  );
}

export default EntryDetail;
