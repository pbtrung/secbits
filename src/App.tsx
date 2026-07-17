// Root component: App is just the session gate (shows AppSetup until login
// succeeds, then hands off to MainApp). MainApp owns the whole vault UI —
// its state/handlers block (entries, trash, selection, editing, save/
// delete/restore) lives in useVaultState (src/hooks/useVaultState.ts); this
// file's MainApp body is the three-pane/mobile-stacked layout that consumes
// it, plus the header search box and settings/trash navigation.
import { useState, useCallback, useEffect } from 'react';
import type { FormEvent } from 'react';
import AppSetup from './components/AppSetup';
import TagsSidebar from './components/TagsSidebar';
import EntryList from './components/EntryList';
import EntryDetail from './components/EntryDetail';
import ResizeHandle from './components/ResizeHandle';
import SettingsList from './components/SettingsList';
import SettingsPanel from './components/SettingsPanel';
import { clearSession, fetchUserEntries } from './db';
import { normalizeEntry } from './lib/entryUtils';
import { useVaultState } from './hooks/useVaultState';
import type { Entry } from './types';

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

interface MainAppProps {
  initialUserName: string;
  initialEntries: Entry[];
  initialTrash: Entry[];
  initialSyncError: string;
  onLogout: () => void;
}

function MainApp({ initialUserName, initialEntries, initialTrash, initialSyncError, onLogout }: MainAppProps) {
  const RESIZE_HANDLE_WIDTH = 5;
  const [tagsWidth, setTagsWidth] = useState(220);
  const [entriesWidth, setEntriesWidth] = useState(320);
  const userName = initialUserName;

  const isMobile = useIsMobile();
  const vault = useVaultState({ initialEntries, initialTrash, initialSyncError, isMobile, onLogout });

  const handleResizeTags = useCallback((delta: number) => {
    setTagsWidth((w) => Math.max(140, Math.min(400, w + delta)));
  }, []);

  const handleResizeEntries = useCallback((delta: number) => {
    setEntriesWidth((w) => Math.max(200, Math.min(600, w + delta)));
  }, []);

  const preventSubmit = (e: FormEvent<HTMLFormElement>) => e.preventDefault();

  const detailPane = vault.selectedEntry ? (
    <EntryDetail
      key={vault.selectedEntry.id}
      entry={vault.selectedEntry}
      isEditing={!vault.trashMode && vault.editingId === vault.selectedEntry.id}
      onEdit={vault.handleEdit}
      onSave={vault.handleSave}
      onDelete={vault.handleDelete}
      onCancel={vault.handleCancelEdit}
      saving={vault.saving}
      deleting={vault.deleting}
      allTags={vault.allTags}
      onDirtyChange={vault.handleDirtyChange}
      onRestore={vault.trashMode ? vault.handleRestoreDeletedVersion : vault.handleRestore}
      onRestoreEntry={vault.handleRestoreDeletedEntry}
      isTrashView={vault.trashMode}
      isMobile={isMobile}
    />
  ) : (
    <div className="d-flex align-items-center justify-content-center h-100 text-muted">
      <div className="text-center">
        <i className={`bi ${vault.trashMode ? 'bi-trash' : 'bi-shield-lock'}`} style={{ fontSize: '4rem' }}></i>
        <p className="mt-3">
          {vault.trashMode ? 'Select a deleted entry to view details' : 'Select an entry to view details'}
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
            {vault.mobileView !== 'tags' && (
              <button className="btn btn-outline-light btn-sm flex-shrink-0 me-2" onClick={vault.handleMobileBack}>
                <i className="bi bi-chevron-left"></i>
              </button>
            )}
            <form
              className="m-0"
              style={{
                minWidth: 0,
                width: vault.mobileView !== 'tags' ? 'calc(100% - 42px)' : '100%',
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
                  value={vault.searchQuery}
                  onChange={vault.handleSearchChange}
                  maxLength={256}
                  disabled={vault.settingsMode || vault.editingId !== null}
                />
                {vault.searchQuery && (
                  <button
                    type="button"
                    className="btn btn-secondary border-secondary"
                    onClick={vault.handleClearSearch}
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
                    value={vault.searchQuery}
                    onChange={vault.handleSearchChange}
                    maxLength={256}
                    disabled={vault.settingsMode || vault.editingId !== null}
                  />
                  {vault.searchQuery && (
                    <button
                      type="button"
                      className="btn btn-secondary border-secondary"
                      onClick={vault.handleClearSearch}
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
      {vault.syncError && (
        <div className="alert alert-danger rounded-0 mb-0 py-2 px-3" role="alert">
          {vault.syncError}
        </div>
      )}

      {/* Main content */}
      <div className="flex-grow-1 overflow-hidden">
        {isMobile ? (
          /* Mobile: stacked views with navigation */
          <div className="h-100">
            {vault.mobileView === 'tags' && (
              <TagsSidebar
                tags={vault.allTags}
                allCount={vault.entries.length}
                tagCounts={vault.tagCounts}
                selectedTag={vault.selectedTag}
                onSelectTag={vault.handleSelectTag}
                onOpenTrash={vault.handleOpenTrash}
                trashCount={vault.trashEntries.length}
                trashMode={vault.trashMode}
                userName={userName}
                onSettings={vault.handleSettings}
                onLogout={vault.handleLogoutGuarded}
                settingsMode={vault.settingsMode}
                mobile
              />
            )}
            {vault.mobileView === 'entries' &&
              (vault.settingsMode ? (
                <SettingsList selectedPage={vault.settingsPage} onSelectPage={vault.handleSelectSettingMobile} mobile />
              ) : (
                <EntryList
                  entries={vault.filteredEntries}
                  selectedEntryId={vault.selectedEntryId}
                  onSelectEntry={vault.handleSelectEntry}
                  onNewEntry={vault.handleNewEntry}
                  selectedTag={vault.selectedTag}
                  trashMode={vault.trashMode}
                  mobile
                />
              ))}
            {vault.mobileView === 'detail' && (
              <div className="h-100 overflow-auto bg-light">
                {vault.settingsMode ? <SettingsPanel page={vault.settingsPage} /> : detailPane}
              </div>
            )}
          </div>
        ) : (
          /* Desktop: resizable 3-column layout */
          <div className="d-flex h-100">
            <div className="d-flex flex-column bg-white" style={{ width: tagsWidth, flexShrink: 0 }}>
              <TagsSidebar
                tags={vault.allTags}
                allCount={vault.entries.length}
                tagCounts={vault.tagCounts}
                selectedTag={vault.selectedTag}
                onSelectTag={vault.handleSelectTag}
                onOpenTrash={vault.handleOpenTrash}
                trashCount={vault.trashEntries.length}
                trashMode={vault.trashMode}
                userName={userName}
                onSettings={vault.handleSettings}
                onLogout={vault.handleLogoutGuarded}
                settingsMode={vault.settingsMode}
              />
            </div>
            <ResizeHandle onResize={handleResizeTags} />
            <div className="d-flex flex-column bg-white" style={{ width: entriesWidth, flexShrink: 0 }}>
              {vault.settingsMode ? (
                <SettingsList selectedPage={vault.settingsPage} onSelectPage={vault.handleSelectSetting} />
              ) : (
                <EntryList
                  entries={vault.filteredEntries}
                  selectedEntryId={vault.selectedEntryId}
                  onSelectEntry={vault.handleSelectEntry}
                  onNewEntry={vault.handleNewEntry}
                  selectedTag={vault.selectedTag}
                  trashMode={vault.trashMode}
                />
              )}
            </div>
            <ResizeHandle onResize={handleResizeEntries} />
            <div className="flex-grow-1 overflow-auto bg-light" style={{ minWidth: 300 }}>
              {vault.settingsMode ? <SettingsPanel page={vault.settingsPage} /> : detailPane}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
