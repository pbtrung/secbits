import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import FirebaseSetup from './components/FirebaseSetup';
import TagsSidebar from './components/TagsSidebar';
import EntryList from './components/EntryList';
import EntryDetail from './components/EntryDetail';
import ResizeHandle from './components/ResizeHandle';
import SettingsList from './components/SettingsList';
import SettingsPanel from './components/SettingsPanel';
import { clearUserMasterKey, fetchUserEntries, createUserEntry, updateUserEntry, deleteUserEntry } from './firebase';

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isMobile;
}

function App() {
  const [session, setSession] = useState(null);

  const handleReady = useCallback(async (userId, userName) => {
    try {
      const { entries: data, failedCount } = await fetchUserEntries(userId);
      const filtered = data
        .map((e) => ({
          title: '',
          username: '',
          password: '',
          notes: '',
          ...e,
          urls: Array.isArray(e.urls) ? e.urls : [],
          totpSecrets: Array.isArray(e.totpSecrets) ? e.totpSecrets : [],
          hiddenFields: Array.isArray(e.hiddenFields) ? e.hiddenFields : [],
          tags: Array.isArray(e.tags) ? e.tags : [],
        }));
      const initialSyncError = failedCount > 0
        ? `${failedCount} entry(ies) could not be decrypted and were skipped. Check your master key.`
        : '';
      setSession({ userId, userName, initialEntries: filtered, initialSyncError });
    } catch {
      setSession({
        userId,
        userName,
        initialEntries: [],
        initialSyncError: 'Failed to load entries from Firebase.',
      });
    }
  }, []);

  const handleLogout = useCallback(() => {
    clearUserMasterKey();
    sessionStorage.removeItem('secbits_config');
    setSession(null);
  }, []);

  if (!session) {
    return <FirebaseSetup onReady={handleReady} />;
  }

  return (
    <MainApp
      userId={session.userId}
      initialUserName={session.userName}
      initialEntries={session.initialEntries}
      initialSyncError={session.initialSyncError}
      onLogout={handleLogout}
    />
  );
}

let nextLocalId = 1;
const getNextId = () => String(nextLocalId++);
const isLocalEntryId = (id) => String(id).startsWith('local-');

function MainApp({ userId, initialUserName, initialEntries, initialSyncError, onLogout }) {
  const RESIZE_HANDLE_WIDTH = 5;
  const [entries, setEntries] = useState(initialEntries || []);
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
  const userName = initialUserName;
  // Mobile navigation: 'tags' | 'entries' | 'detail'
  const [mobileView, setMobileView] = useState('tags');

  const isMobile = useIsMobile();
  const dirtyRef = useRef(false);
  const selectedEntryIdRef = useRef(null);
  const prevSelectedIdRef = useRef(null);
  useEffect(() => { selectedEntryIdRef.current = selectedEntryId; }, [selectedEntryId]);

  const handleDirtyChange = useCallback((dirty) => {
    dirtyRef.current = dirty;
  }, []);

  const confirmUnsavedChanges = useCallback(() => {
    if (!dirtyRef.current) return true;
    return window.confirm('You have unsaved changes. Discard and leave?');
  }, []);

  useEffect(() => {
    if (!editingId) return;
    const handler = (e) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editingId]);

  const handleResizeTags = useCallback((delta) => {
    setTagsWidth((w) => Math.max(140, Math.min(400, w + delta)));
  }, []);

  const handleResizeEntries = useCallback((delta) => {
    setEntriesWidth((w) => Math.max(200, Math.min(600, w + delta)));
  }, []);

  const allTags = useMemo(() => {
    const tagSet = new Set();
    entries.forEach((e) => e.tags.forEach((t) => tagSet.add(t)));
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
    let result = entries;
    if (selectedTag) {
      result = result.filter((e) => e.tags.includes(selectedTag));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.username.toLowerCase().includes(q) ||
          e.urls.some((u) => u.toLowerCase().includes(q))
      );
    }
    return result;
  }, [entries, selectedTag, searchQuery]);

  const selectedEntry = entries.find((e) => e.id === selectedEntryId) || null;

  const handleSelectTag = useCallback((tag) => {
    if (!confirmUnsavedChanges()) return;
    setSelectedTag(tag);
    setSelectedEntryId(null);
    setEditingId(null);
    setSettingsMode(false);
    setSettingsPage(null);
    if (isMobile) setMobileView('entries');
  }, [isMobile, confirmUnsavedChanges]);

  const handleSelectEntry = useCallback((id) => {
    if (!confirmUnsavedChanges()) return;
    setSelectedEntryId(id);
    setEditingId(null);
    if (isMobile) setMobileView('detail');
  }, [isMobile, confirmUnsavedChanges]);

  const handleNewEntry = useCallback(() => {
    prevSelectedIdRef.current = selectedEntryIdRef.current;
    const newEntry = {
      id: `local-${getNextId()}`,
      _isNew: true,
      title: '',
      username: '',
      password: '',
      urls: [''],
      totpSecrets: [],
      hiddenFields: [],
      notes: '',
      tags: selectedTag ? [selectedTag] : [],
    };
    setEntries((prev) => [newEntry, ...prev]);
    setSelectedEntryId(newEntry.id);
    setEditingId(newEntry.id);
    if (isMobile) setMobileView('detail');
  }, [selectedTag, isMobile]);

  const handleSave = useCallback(async (updated) => {
    setSyncError('');
    setSaving(true);
    const wasNew = isLocalEntryId(updated.id) || updated._isNew;

    try {
      if (wasNew) {
        const created = await createUserEntry(userId, updated);
        setEntries((prev) => prev.map((e) => (e.id === updated.id ? created : e)));
        setSelectedEntryId(created.id);
      } else {
        const persisted = await updateUserEntry(userId, updated.id, updated);
        setEntries((prev) => prev.map((e) => (e.id === updated.id ? persisted : e)));
      }
      setEditingId(null);
    } catch (err) {
      setSyncError(err?.message || 'Failed to save entry to Firebase.');
    } finally {
      setSaving(false);
    }
  }, [userId]);

  const handleDelete = useCallback(async (id) => {
    setSyncError('');
    setDeleting(true);

    try {
      if (!isLocalEntryId(id)) {
        await deleteUserEntry(userId, id);
      }
      setEntries((prev) => prev.filter((e) => e.id !== id));
      setSelectedEntryId((prev) => (prev === id ? null : prev));
      setEditingId(null);
      if (isMobile) setMobileView('entries');
    } catch {
      setSyncError('Failed to delete entry from Firebase.');
    } finally {
      setDeleting(false);
    }
  }, [isMobile, userId]);

  const handleEdit = useCallback((id) => {
    setEditingId(id);
  }, []);

  const handleSettings = useCallback(() => {
    if (!confirmUnsavedChanges()) return;
    setSettingsMode((prev) => {
      if (!prev) {
        setSelectedEntryId(null);
        setEditingId(null);
        setSettingsPage(null);
      }
      return !prev;
    });
  }, [confirmUnsavedChanges]);

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
      setEntries((prev) => prev.filter((e) => e.id !== editingId));
      setSelectedEntryId(restoreId);
      if (isMobile) setMobileView(restoreId ? 'detail' : 'entries');
    }

    setEditingId(null);
  }, [isMobile, editingId, confirmUnsavedChanges]);

  const handleMobileBack = () => {
    if (mobileView === 'detail') setMobileView('entries');
    else if (mobileView === 'entries') setMobileView('tags');
  };

  const handleLogoutGuarded = useCallback(() => {
    if (!confirmUnsavedChanges()) return;
    onLogout();
  }, [onLogout, confirmUnsavedChanges]);

  const detailPane = selectedEntry ? (
    <EntryDetail
      key={selectedEntry.id}
      entry={selectedEntry}
      isEditing={editingId === selectedEntry.id}
      onEdit={handleEdit}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancelEdit}
      saving={saving}
      deleting={deleting}
      allTags={allTags}
      onDirtyChange={handleDirtyChange}
    />
  ) : (
    <div className="d-flex align-items-center justify-content-center h-100 text-muted">
      <div className="text-center">
        <i className="bi bi-shield-lock" style={{ fontSize: '4rem' }}></i>
        <p className="mt-3">Select an entry to view details</p>
      </div>
    </div>
  );

  return (
    <div className="d-flex flex-column vh-100">
      {/* Header */}
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
              onSubmit={(e) => e.preventDefault()}
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
                  onChange={(e) => setSearchQuery(e.target.value)}
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
              <form className="w-100 m-0" onSubmit={(e) => e.preventDefault()}>
                <div className="input-group input-group-sm">
                  <span className="input-group-text bg-secondary border-secondary text-light">
                    <i className="bi bi-search"></i>
                  </span>
                  <input
                    type="text"
                    className="form-control bg-secondary border-secondary text-light"
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
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

      {/* Main content */}
      <div className="flex-grow-1 overflow-hidden">
        {isMobile ? (
          /* Mobile: stacked views with navigation */
          <div className="h-100">
            {mobileView === 'tags' && (
              <TagsSidebar
                tags={allTags}
                allCount={entries.length}
                tagCounts={tagCounts}
                selectedTag={selectedTag}
                onSelectTag={handleSelectTag}
                userName={userName}
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
                  onSelectPage={(page) => { handleSelectSetting(page); setMobileView('detail'); }}
                  mobile
                />
              ) : (
                <EntryList
                  entries={filteredEntries}
                  selectedEntryId={selectedEntryId}
                  onSelectEntry={handleSelectEntry}
                  onNewEntry={handleNewEntry}
                  selectedTag={selectedTag}
                  mobile
                />
              )
            )}
            {mobileView === 'detail' && (
              <div className="h-100 overflow-auto bg-light">
                {settingsMode ? (
                  <SettingsPanel page={settingsPage} userId={userId} />
                ) : (
                  detailPane
                )}
              </div>
            )}
          </div>
        ) : (
          /* Desktop: resizable 3-column layout */
          <div className="d-flex h-100">
            <div className="d-flex flex-column bg-white" style={{ width: tagsWidth, flexShrink: 0 }}>
              <TagsSidebar
                tags={allTags}
                allCount={entries.length}
                tagCounts={tagCounts}
                selectedTag={selectedTag}
                onSelectTag={handleSelectTag}
                userName={userName}
                onSettings={handleSettings}
                onLogout={handleLogoutGuarded}
                settingsMode={settingsMode}
              />
            </div>
            <ResizeHandle onResize={handleResizeTags} />
            <div className="d-flex flex-column bg-white" style={{ width: entriesWidth, flexShrink: 0 }}>
              {settingsMode ? (
                <SettingsList
                  selectedPage={settingsPage}
                  onSelectPage={handleSelectSetting}
                />
              ) : (
                <EntryList
                  entries={filteredEntries}
                  selectedEntryId={selectedEntryId}
                  onSelectEntry={handleSelectEntry}
                  onNewEntry={handleNewEntry}
                  selectedTag={selectedTag}
                />
              )}
            </div>
            <ResizeHandle onResize={handleResizeEntries} />
            <div className="flex-grow-1 overflow-auto bg-light" style={{ minWidth: 300 }}>
              {settingsMode ? (
                <SettingsPanel page={settingsPage} userId={userId} />
              ) : (
                detailPane
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
