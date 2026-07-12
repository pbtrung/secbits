import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import AppSetup from './components/AppSetup';
import TagsSidebar from './components/TagsSidebar';
import EntryList from './components/EntryList';
import EntryDetail from './components/EntryDetail';
import ResizeHandle from './components/ResizeHandle';
import SettingsList from './components/SettingsList';
import SettingsPanel from './components/SettingsPanel';
import {
  clearSession,
  fetchUserEntries,
  createUserEntry,
  updateUserEntry,
  deleteUserEntry,
  restoreEntryVersion,
  restoreDeletedUserEntry,
  restoreDeletedEntryVersion,
  permanentlyDeleteUserEntry,
} from './db';
import { filterEntries, normalizeEntry } from './lib/entryUtils';
import type { Entry, EntryType } from './types';

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isMobile;
}

interface Session {
  userId: string;
  userName: string;
  initialEntries: Entry[];
  initialTrash: Entry[];
  initialSyncError: string;
}

function App() {
  const [session, setSession] = useState<Session | null>(null);

  const handleReady = useCallback(async (userId: string, userName: string) => {
    const { entries: data, trash, failedCount } = await fetchUserEntries();
    const filtered = data.map(normalizeEntry);
    const deleted = trash.map(normalizeEntry);
    const initialSyncError =
      failedCount > 0
        ? `${failedCount} entry(ies) could not be decrypted and were skipped. Check your master key.`
        : '';
    setSession({ userId, userName, initialEntries: filtered, initialTrash: deleted, initialSyncError });
  }, []);

  const handleLogout = useCallback(() => {
    clearSession();
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

const isLocalEntryId = (id: string) => String(id).startsWith('local-');

function buildBlankEntry(type: EntryType, selectedTag: string | null): Entry {
  return {
    id: `local-${crypto.randomUUID()}`,
    _isNew: true,
    type,
    title: '',
    username: '',
    password: '',
    urls: [''],
    totpSecrets: [],
    customFields: [],
    notes: '',
    tags: selectedTag ? [selectedTag] : [],
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...(type === 'card' ? { cardholderName: '', cardNumber: '', cardExpiry: '', cardCvv: '' } : {}),
  };
}

function persistEntryUpdate(updated: Entry, wasNew: boolean): Promise<Entry> {
  return wasNew ? createUserEntry(updated) : updateUserEntry(updated.id, updated);
}

// isLocalEntryId(editingId) means the draft was never saved: discarding it
// only needs confirmation if it's actually been touched (dirtyRef). An
// already-saved entry being edited always goes through the normal
// unsaved-changes confirmation instead.
function canDiscardEdit(editingId: string | null, isDirty: boolean, confirmUnsavedChanges: () => boolean): boolean {
  if (editingId && isLocalEntryId(editingId)) {
    return !isDirty || window.confirm('Discard this new entry?');
  }
  return confirmUnsavedChanges();
}

type MobileView = 'tags' | 'entries' | 'detail';
type SettingsPageId = 'export' | 'security' | 'about';

interface MainAppProps {
  initialUserName: string;
  initialEntries: Entry[];
  initialTrash: Entry[];
  initialSyncError: string;
  onLogout: () => void;
}

function MainApp({ initialUserName, initialEntries, initialTrash, initialSyncError, onLogout }: MainAppProps) {
  const RESIZE_HANDLE_WIDTH = 5;
  const [entries, setEntries] = useState<Entry[]>(initialEntries || []);
  const [trashEntries, setTrashEntries] = useState<Entry[]>(initialTrash || []);
  const [trashMode, setTrashMode] = useState(false);
  const [syncError, setSyncError] = useState(initialSyncError || '');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [settingsMode, setSettingsMode] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPageId | null>(null);
  const [tagsWidth, setTagsWidth] = useState(220);
  const [entriesWidth, setEntriesWidth] = useState(320);
  const userName = initialUserName;
  // Mobile navigation: 'tags' | 'entries' | 'detail'
  const [mobileView, setMobileView] = useState<MobileView>('tags');

  const isMobile = useIsMobile();
  const dirtyRef = useRef(false);
  const selectedEntryIdRef = useRef<string | null>(null);
  const prevSelectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedEntryIdRef.current = selectedEntryId;
  }, [selectedEntryId]);

  const handleDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  const confirmUnsavedChanges = useCallback(() => {
    if (!dirtyRef.current) return true;
    return window.confirm('You have unsaved changes. Discard and leave?');
  }, []);

  useEffect(() => {
    if (!editingId) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editingId]);

  const handleResizeTags = useCallback((delta: number) => {
    setTagsWidth((w) => Math.max(140, Math.min(400, w + delta)));
  }, []);

  const handleResizeEntries = useCallback((delta: number) => {
    setEntriesWidth((w) => Math.max(200, Math.min(600, w + delta)));
  }, []);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    entries.forEach((e) => e.tags.forEach((t) => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [entries]);

  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    entries.forEach((entry) => {
      entry.tags.forEach((tag) => {
        counts[tag] = (counts[tag] || 0) + 1;
      });
    });
    return counts;
  }, [entries]);

  const filteredEntries = useMemo(() => {
    if (trashMode) return trashEntries;
    return filterEntries(entries, { selectedTag, searchQuery });
  }, [entries, trashEntries, trashMode, selectedTag, searchQuery]);

  const selectedEntry = (trashMode ? trashEntries : entries).find((e) => e.id === selectedEntryId) || null;

  const handleSelectTag = useCallback(
    (tag: string | null) => {
      if (!confirmUnsavedChanges()) return;
      setTrashMode(false);
      setSelectedTag(tag);
      setSelectedEntryId(null);
      setEditingId(null);
      setSettingsMode(false);
      setSettingsPage(null);
      if (isMobile) setMobileView('entries');
    },
    [isMobile, confirmUnsavedChanges],
  );

  const handleSelectEntry = useCallback(
    (id: string) => {
      if (!confirmUnsavedChanges()) return;
      setSelectedEntryId(id);
      setEditingId(null);
      if (isMobile) setMobileView('detail');
    },
    [isMobile, confirmUnsavedChanges],
  );

  const handleOpenTrash = useCallback(() => {
    if (!trashEntries.length) return;
    if (!confirmUnsavedChanges()) return;
    setTrashMode(true);
    setSelectedTag(null);
    setSelectedEntryId(null);
    setEditingId(null);
    setSettingsMode(false);
    setSettingsPage(null);
    if (isMobile) setMobileView('entries');
  }, [trashEntries.length, isMobile, confirmUnsavedChanges]);

  const handleNewEntry = useCallback(
    (type: EntryType) => {
      if (trashMode) return;
      if (!confirmUnsavedChanges()) return;
      prevSelectedIdRef.current = selectedEntryIdRef.current;
      const newEntry = buildBlankEntry(type, selectedTag);
      setEntries((prev) => [newEntry, ...prev]);
      setSelectedEntryId(newEntry.id);
      setEditingId(newEntry.id);
      if (isMobile) setMobileView('detail');
    },
    [selectedTag, isMobile, trashMode, confirmUnsavedChanges],
  );

  const handleSave = useCallback(
    async (updated: Entry) => {
      if (trashMode) return;
      setSyncError('');
      setSaving(true);
      const wasNew = isLocalEntryId(updated.id) || Boolean(updated._isNew);

      try {
        const saved = await persistEntryUpdate(updated, wasNew);
        setEntries((prev) => prev.map((e) => (e.id === updated.id ? saved : e)));
        if (wasNew) setSelectedEntryId(saved.id);
        setEditingId(null);
      } catch (err) {
        setSyncError(err instanceof Error ? err.message : 'Failed to save entry.');
      } finally {
        setSaving(false);
      }
    },
    [trashMode],
  );

  const handleRestore = useCallback(async (entryId: string, commitHash: string) => {
    setSyncError('');
    setSaving(true);
    try {
      const restored = await restoreEntryVersion(entryId, commitHash);
      setEntries((prev) => prev.map((e) => (e.id === entryId ? normalizeEntry(restored) : e)));
      return true;
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Failed to restore entry.');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  // Shared by handleRestoreDeletedVersion/handleRestoreDeletedEntry: both
  // move a just-restored entry out of the trash list and into the live one.
  const restoreEntryFromTrash = useCallback((entryId: string, restored: Entry) => {
    setTrashEntries((prev) => prev.filter((e) => e.id !== entryId));
    setEntries((prev) => [restored, ...prev.filter((e) => e.id !== restored.id)]);
    setTrashMode(false);
    setSelectedEntryId(restored.id);
  }, []);

  const handleRestoreDeletedVersion = useCallback(
    async (entryId: string, commitHash: string) => {
      setSyncError('');
      setSaving(true);
      try {
        const restored = normalizeEntry(await restoreDeletedEntryVersion(entryId, commitHash));
        restoreEntryFromTrash(entryId, restored);
        return true;
      } catch (err) {
        setSyncError(err instanceof Error ? err.message : 'Failed to restore deleted entry version.');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [restoreEntryFromTrash],
  );

  const handleRestoreDeletedEntry = useCallback(
    async (entryId: string) => {
      setSyncError('');
      setSaving(true);
      try {
        const restored = normalizeEntry(await restoreDeletedUserEntry(entryId));
        restoreEntryFromTrash(entryId, restored);
        setEditingId(null);
        if (isMobile) setMobileView('detail');
      } catch (err) {
        setSyncError(err instanceof Error ? err.message : 'Failed to restore deleted entry.');
      } finally {
        setSaving(false);
      }
    },
    [isMobile, restoreEntryFromTrash],
  );

  // Removes an entry from wherever it currently lives: permanently from
  // trash, soft-deleted into trash from the live list, or (for an unsaved
  // local draft) just discarded outright.
  const removeEntryByMode = useCallback(
    async (id: string) => {
      if (trashMode) {
        await permanentlyDeleteUserEntry(id);
        setTrashEntries((prev) => prev.filter((e) => e.id !== id));
        return;
      }
      if (!isLocalEntryId(id)) {
        const trashed = await deleteUserEntry(id);
        setEntries((prev) => prev.filter((e) => e.id !== id));
        setTrashEntries((prev) => [trashed, ...prev.filter((e) => e.id !== trashed.id)]);
        return;
      }
      setEntries((prev) => prev.filter((e) => e.id !== id));
    },
    [trashMode],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setSyncError('');
      setDeleting(true);
      try {
        await removeEntryByMode(id);
        setSelectedEntryId((prev) => (prev === id ? null : prev));
        setEditingId(null);
        if (isMobile) setMobileView('entries');
      } catch (err) {
        setSyncError(err instanceof Error ? err.message : 'Failed to delete entry.');
      } finally {
        setDeleting(false);
      }
    },
    [isMobile, removeEntryByMode],
  );

  const handleEdit = useCallback(
    (id: string) => {
      if (trashMode) return;
      setEditingId(id);
    },
    [trashMode],
  );

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

  const handleSelectSetting = useCallback((page: string) => {
    setSettingsPage(page as SettingsPageId);
  }, []);

  const handleCancelEdit = useCallback(() => {
    if (!canDiscardEdit(editingId, dirtyRef.current, confirmUnsavedChanges)) return;

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
    if (mobileView === 'detail') {
      if (!confirmUnsavedChanges()) return;
      setMobileView('entries');
    } else if (mobileView === 'entries') setMobileView('tags');
  };

  const handleLogoutGuarded = useCallback(() => {
    if (!confirmUnsavedChanges()) return;
    onLogout();
  }, [onLogout, confirmUnsavedChanges]);

  const handleSearchChange = (e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value);
  const preventSubmit = (e: FormEvent<HTMLFormElement>) => e.preventDefault();

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
      onRestore={trashMode ? handleRestoreDeletedVersion : handleRestore}
      onRestoreEntry={handleRestoreDeletedEntry}
      isTrashView={trashMode}
      isMobile={isMobile}
    />
  ) : (
    <div className="d-flex align-items-center justify-content-center h-100 text-muted">
      <div className="text-center">
        <i className={`bi ${trashMode ? 'bi-trash' : 'bi-shield-lock'}`} style={{ fontSize: '4rem' }}></i>
        <p className="mt-3">
          {trashMode ? 'Select a deleted entry to view details' : 'Select an entry to view details'}
        </p>
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
              <button className="btn btn-outline-light btn-sm flex-shrink-0 me-2" onClick={handleMobileBack}>
                <i className="bi bi-chevron-left"></i>
              </button>
            )}
            <form
              className="m-0"
              style={{
                minWidth: 0,
                width: mobileView !== 'tags' ? 'calc(100% - 42px)' : '100%',
              }}
              onSubmit={preventSubmit}
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
                  onChange={handleSearchChange}
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
              <form className="w-100 m-0" onSubmit={preventSubmit}>
                <div className="input-group input-group-sm">
                  <span className="input-group-text bg-secondary border-secondary text-light">
                    <i className="bi bi-search"></i>
                  </span>
                  <input
                    type="text"
                    className="form-control bg-secondary border-secondary text-light"
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={handleSearchChange}
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
                onOpenTrash={handleOpenTrash}
                trashCount={trashEntries.length}
                trashMode={trashMode}
                userName={userName}
                onSettings={handleSettings}
                onLogout={handleLogoutGuarded}
                settingsMode={settingsMode}
                mobile
              />
            )}
            {mobileView === 'entries' &&
              (settingsMode ? (
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
              ))}
            {mobileView === 'detail' && (
              <div className="h-100 overflow-auto bg-light">
                {settingsMode ? <SettingsPanel page={settingsPage} /> : detailPane}
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
                onOpenTrash={handleOpenTrash}
                trashCount={trashEntries.length}
                trashMode={trashMode}
                userName={userName}
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
