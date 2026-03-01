import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TagsSidebar from '../components/TagsSidebar.jsx';

describe('TagsSidebar', () => {
  it('renders tag counts and handlers', () => {
    const onSelectTag = vi.fn();
    const onOpenTrash = vi.fn();

    render(
      <TagsSidebar
        tags={['work', 'mail']}
        allCount={4}
        tagCounts={{ work: 3, mail: 1 }}
        selectedTag={null}
        onSelectTag={onSelectTag}
        onOpenTrash={onOpenTrash}
        trashCount={2}
        userName="alice"
        onSettings={() => {}}
      />
    );

    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /trash/i }));
    expect(onOpenTrash).toHaveBeenCalled();
  });
});
