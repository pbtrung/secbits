import React, { useState, useMemo } from 'react';
import TagsSidebar from './components/TagsSidebar';
import EntryList from './components/EntryList';
import EntryDetail from './components/EntryDetail';
import { sampleUser, sampleEntries, getNextId } from './sampleData';

function App() {
  const [entries, setEntries] = useState(sampleEntries);
  const [selectedTag, setSelectedTag] = useState(null);
  const [selectedEntryId, setSelectedEntryId] = useState(null);
  const [editingId, setEditingId] = useState(null);

  const allTags = useMemo(() => {
    const tagSet = new Set();
    entries.forEach((e) => e.tags.forEach((t) => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [entries]);

  const filteredEntries = useMemo(() => {
    if (!selectedTag) return entries;
    return entries.filter((e) => e.tags.includes(selectedTag));
  }, [entries, selectedTag]);

  const selectedEntry = entries.find((e) => e.id === selectedEntryId) || null;

  const handleSelectTag = (tag) => {
    setSelectedTag(tag);
    setSelectedEntryId(null);
    setEditingId(null);
  };

  const handleSelectEntry = (id) => {
    setSelectedEntryId(id);
    setEditingId(null);
  };

  const handleNewEntry = () => {
    const newEntry = {
      id: getNextId(),
      title: '',
      username: '',
      password: '',
      urls: [''],
      hiddenFields: [],
      notes: '',
      tags: selectedTag ? [selectedTag] : [],
    };
    setEntries([newEntry, ...entries]);
    setSelectedEntryId(newEntry.id);
    setEditingId(newEntry.id);
  };

  const handleSave = (updated) => {
    setEntries(entries.map((e) => (e.id === updated.id ? updated : e)));
    setEditingId(null);
  };

  const handleDelete = (id) => {
    setEntries(entries.filter((e) => e.id !== id));
    if (selectedEntryId === id) setSelectedEntryId(null);
    setEditingId(null);
  };

  const handleEdit = (id) => {
    setEditingId(id);
  };

  const handleCancelEdit = () => {
    const entry = entries.find((e) => e.id === editingId);
    if (entry && !entry.title && !entry.username) {
      setEntries(entries.filter((e) => e.id !== editingId));
      setSelectedEntryId(null);
    }
    setEditingId(null);
  };

  return (
    <div className="d-flex flex-column vh-100">
      {/* Header */}
      <nav className="navbar navbar-dark bg-dark px-3">
        <span className="navbar-brand mb-0 h1">
          <i className="bi bi-shield-lock me-2"></i>
          SecBits
        </span>
        <span className="text-light">
          <i className="bi bi-person-circle me-1"></i>
          {sampleUser.name}
        </span>
      </nav>

      {/* Main 3-column layout */}
      <div className="flex-grow-1 d-flex overflow-hidden">
        {/* Column 1: Tags */}
        <TagsSidebar
          tags={allTags}
          selectedTag={selectedTag}
          onSelectTag={handleSelectTag}
        />

        {/* Column 2: Entry List */}
        <EntryList
          entries={filteredEntries}
          selectedEntryId={selectedEntryId}
          onSelectEntry={handleSelectEntry}
          onNewEntry={handleNewEntry}
          selectedTag={selectedTag}
        />

        {/* Column 3: Entry Detail */}
        <div className="flex-grow-1 overflow-auto bg-light">
          {selectedEntry ? (
            <EntryDetail
              key={selectedEntry.id}
              entry={selectedEntry}
              isEditing={editingId === selectedEntry.id}
              onEdit={handleEdit}
              onSave={handleSave}
              onDelete={handleDelete}
              onCancel={handleCancelEdit}
            />
          ) : (
            <div className="d-flex align-items-center justify-content-center h-100 text-muted">
              <div className="text-center">
                <i className="bi bi-shield-lock" style={{ fontSize: '4rem' }}></i>
                <p className="mt-3">Select an entry to view details</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
