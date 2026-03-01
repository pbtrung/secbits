import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PasswordGenerator } from '../components/PasswordGenerator.jsx';

describe('PasswordGenerator', () => {
  it('generates and emits a password', () => {
    const onGenerate = vi.fn();
    const onCopy = vi.fn();

    render(<PasswordGenerator onGenerate={onGenerate} onCopy={onCopy} />);

    fireEvent.click(screen.getByRole('button', { name: /generate password/i }));

    const checkboxUpper = screen.getByLabelText('A-Z');
    fireEvent.click(checkboxUpper);

    fireEvent.click(screen.getByRole('button', { name: /use this password/i }));
    expect(onGenerate).toHaveBeenCalledWith(expect.any(String));
    expect(onGenerate.mock.calls[0][0].length).toBeGreaterThanOrEqual(8);
  });
});
