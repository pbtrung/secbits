// The vault's data/navigation state machine: entries, trash, selection,
// editing, save/delete/restore, and mobile view navigation. Pulled out of
// MainApp (src/App.tsx) so that file's render body reads separately from
// this state machine — nothing here is markup, and nothing in App.tsx's
// render is state logic.
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { ChangeEvent } from 'react';
import {
  createUserEntry,
  updateUserEntry,
  deleteUserEntry,
  restoreEntryVersion,
  restoreDeletedUserEntry,
  restoreDeletedEntryVersion,
  permanentlyDeleteUserEntry,
} from '../db';
import { filterEntries, normalizeEntry } from '../lib/entryUtils';
import type { Entry, EntryType } from '../types';

export type MobileView = 'tags' | 'entries' | 'detail';
export type SettingsPageId = 'export' | 'security' | 'about';

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

export interface UseVaultStateParams {
  initialEntries: Entry[];
  initialTrash: Entry[];
  initialSyncError: string;
  isMobile: boolean;
  onLogout: () => void;
}

export function useVaultState({
  initialEntries,
  initialTrash,
  initialSyncError,
  isMobile,
  onLogout,
}: UseVaultStateParams) {
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
  // Mobile navigation: 'tags' | 'entries' | 'detail'
  const [mobileView, setMobileView] = useState<MobileView>('tags');

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

  // Mobile only: picking a settings page also has to advance mobileView to
  // 'detail', since settings pages render in the same slot as entry detail.
  const handleSelectSettingMobile = useCallback((page: string) => {
    setSettingsPage(page as SettingsPageId);
    setMobileView('detail');
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

  const handleMobileBack = useCallback(() => {
    if (mobileView === 'detail') {
      if (!confirmUnsavedChanges()) return;
      setMobileView('entries');
    } else if (mobileView === 'entries') setMobileView('tags');
  }, [mobileView, confirmUnsavedChanges]);

  const handleLogoutGuarded = useCallback(() => {
    if (!confirmUnsavedChanges()) return;
    onLogout();
  }, [onLogout, confirmUnsavedChanges]);

  const handleSearchChange = useCallback((e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value), []);
  const handleClearSearch = useCallback(() => setSearchQuery(''), []);

  return {
    entries,
    trashEntries,
    trashMode,
    syncError,
    selectedTag,
    selectedEntryId,
    editingId,
    saving,
    deleting,
    searchQuery,
    settingsMode,
    settingsPage,
    mobileView,
    allTags,
    tagCounts,
    filteredEntries,
    selectedEntry,
    handleDirtyChange,
    handleSelectTag,
    handleSelectEntry,
    handleOpenTrash,
    handleNewEntry,
    handleSave,
    handleRestore,
    handleRestoreDeletedVersion,
    handleRestoreDeletedEntry,
    handleDelete,
    handleEdit,
    handleSettings,
    handleSelectSetting,
    handleSelectSettingMobile,
    handleCancelEdit,
    handleMobileBack,
    handleLogoutGuarded,
    handleSearchChange,
    handleClearSearch,
  };
}
