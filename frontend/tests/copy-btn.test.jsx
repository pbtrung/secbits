import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CopyBtn from '../components/CopyBtn.jsx';

describe('CopyBtn', () => {
  it('calls onCopy with text and label', () => {
    const onCopy = vi.fn();
    render(<CopyBtn text="secret" label="password" copied={null} onCopy={onCopy} />);

    fireEvent.click(screen.getByRole('button'));
    expect(onCopy).toHaveBeenCalledWith('secret', 'password');
  });
});
