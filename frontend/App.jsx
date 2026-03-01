import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppSetup from './components/AppSetup';
import TagsSidebar from './components/TagsSidebar';
import EntryList from './components/EntryList';
import EntryDetail from './components/EntryDetail';
import ResizeHandle from './components/ResizeHandle';
import SettingsList from './components/SettingsList';
import SettingsPanel from './components/SettingsPanel';
import {
  fetchUserEntries,
  createUserEntry,
  updateUserEntry,
  deleteUserEntry,
  restoreEntryVersion,
  restoreDeletedUserEntry,
  permanentlyDeleteUserEntry,
  lockVaultSession,
} from './api';

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return isMobile;
}

const isLocalEntryId = (id) => String(id).startsWith('local-');

function normalizeEntry(entry) {
  return {
    title: '',
    username: '',
    password: '',
    notes: '',
    cardholderName: '',
    cardNumber: '',
    expiry: '',
    cvv: '',
    ...entry,
    urls: Array.isArray(entry?.urls) ? entry.urls : [],
    totpSecrets: Array.isArray(entry?.totpSecrets) ? entry.totpSecrets : [],
    customFields: Array.isArray(entry?.customFields) ? entry.customFields : [],
    tags: Array.isArray(entry?.tags) ? entry.tags : [],
    _commits: Array.isArray(entry?._commits) ? entry._commits : [],
  };
}

function App() {
  const [session, setSession] = useState(null);

  const handleReady = useCallback(async (userName) => {
    const { entries, trash, failedCount } = await fetchUserEntries();
    setSession({
      userName,
      initialEntries: entries.map(normalizeEntry),
      initialTrash: trash.map(normalizeEntry),
      initialSyncError: failedCount > 0 ? `${failedCount} entr${failedCount === 1 ? 'y' : 'ies'} could not be loaded.` : '',
    });
  }, []);

  const handleLogout = useCallback(async () => {
    await lockVaultSession().catch(() => {});
    setSession(null);
  }, []);

  if (!session) {
    return <AppSetup onReady={handleReady} />;
  }

  return (
    <MainApp
      initialUserName={session.userName}
      initialEntries={session.initialEntries}
      initialTrash={session.initialTrash}
      initialSyncError={session.initialSyncError}
      onLogout={handleLogout}
    />
  );
}

function MainApp({ initialUserName, initialEntries, initialTrash, initialSyncError, onLogout }) {
  const RESIZE_HANDLE_WIDTH = 5;
  const [entries, setEntries] = useState(initialEntries || []);
  const [trashEntries, setTrashEntries] = useState(initialTrash || []);
  const [trashMode, setTrashMode] = useState(false);
  const [syncError, setSyncError] = useState(initialSyncError || '');
  const [selectedTag, setSelectedTag] = useState(null);
  const [selectedEntryId, setSelectedEntryId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [settingsMode, setSettingsMode] = useState(false);
  const [settingsPage, setSettingsPage] = useState(null);
  const [tagsWidth, setTagsWidth] = useState(220);
  const [entriesWidth, setEntriesWidth] = useState(320);
  const [mobileView, setMobileView] = useState('tags');

  const isMobile = useIsMobile();
  const dirtyRef = useRef(false);
  const selectedEntryIdRef = useRef(null);
  const prevSelectedIdRef = useRef(null);

  useEffect(() => {
    selectedEntryIdRef.current = selectedEntryId;
  }, [selectedEntryId]);

  const handleDirtyChange = useCallback((dirty) => {
    dirtyRef.current = dirty;
  }, []);

  const confirmUnsavedChanges = useCallback(() => {
    if (!dirtyRef.current) return true;
    return window.confirm('You have unsaved changes. Discard and continue?');
  }, []);

  const handleResizeTags = useCallback((delta) => {
    setTagsWidth((w) => Math.max(140, Math.min(400, w + delta)));
  }, []);

  const handleResizeEntries = useCallback((delta) => {
    setEntriesWidth((w) => Math.max(200, Math.min(600, w + delta)));
  }, []);

  const allTags = useMemo(() => {
    const tagSet = new Set();
    entries.forEach((entry) => entry.tags.forEach((tag) => tagSet.add(tag)));
    return Array.from(tagSet).sort();
  }, [entries]);

  const tagCounts = useMemo(() => {
    const counts = {};
    entries.forEach((entry) => {
      entry.tags.forEach((tag) => {
        counts[tag] = (counts[tag] || 0) + 1;
      });
    });
    return counts;
  }, [entries]);

  const filteredEntries = useMemo(() => {
    let result = trashMode ? trashEntries : entries;

    if (!trashMode && selectedTag) {
      result = result.filter((entry) => entry.tags.includes(selectedTag));
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((entry) =>
        (entry.title || '').toLowerCase().includes(q) ||
        (entry.username || '').toLowerCase().includes(q) ||
        (entry.urls || []).some((url) => url.toLowerCase().includes(q))
      );
    }

    return result;
  }, [entries, trashEntries, trashMode, selectedTag, searchQuery]);

  const selectedEntry = (trashMode ? trashEntries : entries).find((entry) => entry.id === selectedEntryId) || null;

  const handleSelectTag = useCallback((tag) => {
    if (!confirmUnsavedChanges()) return;

    setTrashMode(false);
    setSelectedTag(tag);
    setSelectedEntryId(null);
    setEditingId(null);
    setSettingsMode(false);
    setSettingsPage(null);

    if (isMobile) setMobileView('entries');
  }, [confirmUnsavedChanges, isMobile]);

  const handleSelectEntry = useCallback((id) => {
    if (!confirmUnsavedChanges()) return;

    setSelectedEntryId(id);
    setEditingId(null);
    if (isMobile) setMobileView('detail');
  }, [confirmUnsavedChanges, isMobile]);

  const handleOpenTrash = useCallback(() => {
    if (!confirmUnsavedChanges()) return;

    setTrashMode(true);
    setSelectedTag(null);
    setSelectedEntryId(null);
    setEditingId(null);
    setSettingsMode(false);
    setSettingsPage(null);

    if (isMobile) setMobileView('entries');
  }, [confirmUnsavedChanges, isMobile]);

  const handleNewEntry = useCallback((type) => {
    if (trashMode) return;
    if (!confirmUnsavedChanges()) return;

    prevSelectedIdRef.current = selectedEntryIdRef.current;

    const newEntry = normalizeEntry({
      id: `local-${crypto.randomUUID()}`,
      _isNew: true,
      type,
      title: '',
      username: '',
      password: '',
      notes: '',
      urls: [''],
      totpSecrets: [],
      customFields: [],
      tags: selectedTag ? [selectedTag] : [],
      ...(type === 'card' ? { cardholderName: '', cardNumber: '', expiry: '', cvv: '' } : {}),
    });

    setEntries((prev) => [newEntry, ...prev]);
    setSelectedEntryId(newEntry.id);
    setEditingId(newEntry.id);

    if (isMobile) setMobileView('detail');
  }, [trashMode, confirmUnsavedChanges, selectedTag, isMobile]);

  const handleSave = useCallback(async (updatedEntry) => {
    if (trashMode) return;

    setSyncError('');
    setSaving(true);

    const isNew = isLocalEntryId(updatedEntry.id) || updatedEntry._isNew;

    try {
      if (isNew) {
        const created = normalizeEntry(await createUserEntry(updatedEntry));
        setEntries((prev) => prev.map((entry) => (entry.id === updatedEntry.id ? created : entry)));
        setSelectedEntryId(created.id);
      } else {
        const persisted = normalizeEntry(await updateUserEntry(updatedEntry.id, updatedEntry));
        setEntries((prev) => prev.map((entry) => (entry.id === updatedEntry.id ? persisted : entry)));
      }
      setEditingId(null);
    } catch (err) {
      setSyncError(err?.message || 'Failed to save entry.');
    } finally {
      setSaving(false);
    }
  }, [trashMode]);

  const handleRestore = useCallback(async (entryId, commitHash) => {
    setSyncError('');
    setSaving(true);

    try {
      const restored = normalizeEntry(await restoreEntryVersion(entryId, commitHash));
      setEntries((prev) => prev.map((entry) => (entry.id === entryId ? restored : entry)));
      return true;
    } catch (err) {
      setSyncError(err?.message || 'Failed to restore entry version.');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const handleRestoreDeletedEntry = useCallback(async (entryId) => {
    setSyncError('');
    setSaving(true);

    try {
      const restored = normalizeEntry(await restoreDeletedUserEntry(entryId));
      setTrashEntries((prev) => prev.filter((entry) => entry.id !== entryId));
      setEntries((prev) => [restored, ...prev.filter((entry) => entry.id !== restored.id)]);
      setTrashMode(false);
      setSelectedEntryId(restored.id);
      setEditingId(null);
      if (isMobile) setMobileView('detail');
      return true;
    } catch (err) {
      setSyncError(err?.message || 'Failed to restore entry.');
      return false;
    } finally {
      setSaving(false);
    }
  }, [isMobile]);

  const handleDelete = useCallback(async (id) => {
    setSyncError('');
    setDeleting(true);

    try {
      if (trashMode) {
        await permanentlyDeleteUserEntry(id);
        setTrashEntries((prev) => prev.filter((entry) => entry.id !== id));
      } else if (!isLocalEntryId(id)) {
        const trashed = normalizeEntry(await deleteUserEntry(id));
        setEntries((prev) => prev.filter((entry) => entry.id !== id));
        setTrashEntries((prev) => [trashed, ...prev.filter((entry) => entry.id !== trashed.id)]);
      } else {
        setEntries((prev) => prev.filter((entry) => entry.id !== id));
      }

      setSelectedEntryId((prev) => (prev === id ? null : prev));
      setEditingId(null);
      if (isMobile) setMobileView('entries');
    } catch (err) {
      setSyncError(err?.message || 'Failed to delete entry.');
    } finally {
      setDeleting(false);
    }
  }, [isMobile, trashMode]);

  const handleEdit = useCallback((id) => {
    if (trashMode) return;
    setEditingId(id);
  }, [trashMode]);

  const handleSettings = useCallback(() => {
    if (!confirmUnsavedChanges()) return;

    setSettingsMode((prev) => {
      if (!prev) {
        setSelectedEntryId(null);
        setEditingId(null);
        setSettingsPage(null);
        setTrashMode(false);
        if (isMobile) setMobileView('entries');
      }
      return !prev;
    });
  }, [confirmUnsavedChanges, isMobile]);

  const handleSelectSetting = useCallback((page) => {
    setSettingsPage(page);
  }, []);

  const handleCancelEdit = useCallback(() => {
    if (isLocalEntryId(editingId)) {
      if (dirtyRef.current && !window.confirm('Discard this new entry?')) {
        return;
      }
    } else if (!confirmUnsavedChanges()) {
      return;
    }

    if (editingId && isLocalEntryId(editingId)) {
      const restoreId = prevSelectedIdRef.current ?? null;
      prevSelectedIdRef.current = null;
      setEntries((prev) => prev.filter((entry) => entry.id !== editingId));
      setSelectedEntryId(restoreId);
      if (isMobile) setMobileView(restoreId ? 'detail' : 'entries');
    }

    setEditingId(null);
  }, [editingId, confirmUnsavedChanges, isMobile]);

  const handleMobileBack = useCallback(() => {
    if (mobileView === 'detail') {
      if (!confirmUnsavedChanges()) return;
      setMobileView('entries');
      return;
    }

    if (mobileView === 'entries') {
      setMobileView('tags');
    }
  }, [mobileView, confirmUnsavedChanges]);

  const handleLogoutGuarded = useCallback(() => {
    if (!confirmUnsavedChanges()) return;
    onLogout();
  }, [confirmUnsavedChanges, onLogout]);

  const detailPane = selectedEntry ? (
    <EntryDetail
      key={selectedEntry.id}
      entry={selectedEntry}
      isEditing={!trashMode && editingId === selectedEntry.id}
      onEdit={handleEdit}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancelEdit}
      saving={saving}
      deleting={deleting}
      allTags={allTags}
      onDirtyChange={handleDirtyChange}
      onRestore={trashMode ? null : handleRestore}
      onRestoreEntry={handleRestoreDeletedEntry}
      isTrashView={trashMode}
      isMobile={isMobile}
    />
  ) : (
    <div className="d-flex align-items-center justify-content-center h-100 text-muted">
      <div className="text-center">
        <i className={`bi ${trashMode ? 'bi-trash' : 'bi-shield-lock'}`} style={{ fontSize: '4rem' }}></i>
        <p className="mt-3">{trashMode ? 'Select a deleted entry to view details' : 'Select an entry to view details'}</p>
      </div>
    </div>
  );

  return (
    <div className="d-flex flex-column vh-100">
      <nav className="navbar navbar-dark bg-dark px-0 py-1 flex-nowrap justify-content-start" style={{ minHeight: 48 }}>
        {isMobile ? (
          <div className="d-flex align-items-center w-100 px-2">
            {mobileView !== 'tags' && (
              <button
                className="btn btn-outline-light btn-sm flex-shrink-0 me-2"
                onClick={handleMobileBack}
              >
                <i className="bi bi-chevron-left"></i>
              </button>
            )}
            <form
              className="m-0"
              style={{
                minWidth: 0,
                width: mobileView !== 'tags' ? 'calc(100% - 42px)' : '100%',
              }}
              onSubmit={(event) => event.preventDefault()}
            >
              <div className="input-group input-group-sm">
                <span className="input-group-text bg-secondary border-secondary text-light">
                  <i className="bi bi-search"></i>
                </span>
                <input
                  type="text"
                  className="form-control bg-secondary border-secondary text-light"
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  maxLength={256}
                  disabled={settingsMode || editingId !== null}
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="btn btn-secondary border-secondary"
                    onClick={() => setSearchQuery('')}
                  >
                    <i className="bi bi-x-lg"></i>
                  </button>
                )}
              </div>
            </form>
          </div>
        ) : (
          <>
            <div className="d-flex align-items-center px-2" style={{ width: tagsWidth, flexShrink: 0 }}>
              <i className="bi bi-shield-lock text-light fs-5"></i>
              <span className="text-light fw-bold ms-2 me-2">SecBits</span>
            </div>
            <div style={{ width: RESIZE_HANDLE_WIDTH, flexShrink: 0 }}></div>
            <div className="d-flex align-items-center" style={{ width: entriesWidth, flexShrink: 0 }}>
              <form className="w-100 m-0" onSubmit={(event) => event.preventDefault()}>
                <div className="input-group input-group-sm">
                  <span className="input-group-text bg-secondary border-secondary text-light">
                    <i className="bi bi-search"></i>
                  </span>
                  <input
                    type="text"
                    className="form-control bg-secondary border-secondary text-light"
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    maxLength={256}
                    disabled={settingsMode || editingId !== null}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      className="btn btn-secondary border-secondary"
                      onClick={() => setSearchQuery('')}
                    >
                      <i className="bi bi-x-lg"></i>
                    </button>
                  )}
                </div>
              </form>
            </div>
            <div style={{ width: RESIZE_HANDLE_WIDTH, flexShrink: 0 }}></div>
          </>
        )}
      </nav>

      {syncError && (
        <div className="alert alert-danger rounded-0 mb-0 py-2 px-3" role="alert">
          {syncError}
        </div>
      )}

      <div className="flex-grow-1 overflow-hidden">
        {isMobile ? (
          <div className="h-100">
            {mobileView === 'tags' && (
              <TagsSidebar
                tags={allTags}
                allCount={entries.length}
                tagCounts={tagCounts}
                selectedTag={selectedTag}
                onSelectTag={handleSelectTag}
                onOpenTrash={handleOpenTrash}
                trashCount={trashEntries.length}
                trashMode={trashMode}
                userName={initialUserName}
                onSettings={handleSettings}
                onLogout={handleLogoutGuarded}
                settingsMode={settingsMode}
                mobile
              />
            )}

            {mobileView === 'entries' && (
              settingsMode ? (
                <SettingsList
                  selectedPage={settingsPage}
                  onSelectPage={(page) => {
                    handleSelectSetting(page);
                    setMobileView('detail');
                  }}
                  mobile
                />
              ) : (
                <EntryList
                  entries={filteredEntries}
                  selectedEntryId={selectedEntryId}
                  onSelectEntry={handleSelectEntry}
                  onNewEntry={handleNewEntry}
                  selectedTag={selectedTag}
                  trashMode={trashMode}
                  mobile
                />
              )
            )}

            {mobileView === 'detail' && (
              <div className="h-100 overflow-auto bg-light">
                {settingsMode ? <SettingsPanel page={settingsPage} /> : detailPane}
              </div>
            )}
          </div>
        ) : (
          <div className="d-flex h-100">
            <div className="d-flex flex-column bg-white" style={{ width: tagsWidth, flexShrink: 0 }}>
              <TagsSidebar
                tags={allTags}
                allCount={entries.length}
                tagCounts={tagCounts}
                selectedTag={selectedTag}
                onSelectTag={handleSelectTag}
                onOpenTrash={handleOpenTrash}
                trashCount={trashEntries.length}
                trashMode={trashMode}
                userName={initialUserName}
                onSettings={handleSettings}
                onLogout={handleLogoutGuarded}
                settingsMode={settingsMode}
              />
            </div>
            <ResizeHandle onResize={handleResizeTags} />
            <div className="d-flex flex-column bg-white" style={{ width: entriesWidth, flexShrink: 0 }}>
              {settingsMode ? (
                <SettingsList selectedPage={settingsPage} onSelectPage={handleSelectSetting} />
              ) : (
                <EntryList
                  entries={filteredEntries}
                  selectedEntryId={selectedEntryId}
                  onSelectEntry={handleSelectEntry}
                  onNewEntry={handleNewEntry}
                  selectedTag={selectedTag}
                  trashMode={trashMode}
                />
              )}
            </div>
            <ResizeHandle onResize={handleResizeEntries} />
            <div className="flex-grow-1 overflow-auto bg-light" style={{ minWidth: 300 }}>
              {settingsMode ? <SettingsPanel page={settingsPage} /> : detailPane}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
