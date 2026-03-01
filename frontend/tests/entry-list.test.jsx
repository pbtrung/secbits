import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import EntryList from '../components/EntryList.jsx';

describe('EntryList', () => {
  it('renders entries and handles selection', () => {
    const onSelectEntry = vi.fn();
    const onNewEntry = vi.fn();
    render(
      <EntryList
        entries={[
          { id: 1, type: 'login', title: 'Gmail', username: 'alice', tags: ['mail'] },
          { id: 2, type: 'note', title: 'Note', username: '', tags: [] },
        ]}
        selectedEntryId={null}
        onSelectEntry={onSelectEntry}
        onNewEntry={onNewEntry}
        selectedTag={null}
        trashMode={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /gmail/i }));
    expect(onSelectEntry).toHaveBeenCalledWith(1);
  });
});
