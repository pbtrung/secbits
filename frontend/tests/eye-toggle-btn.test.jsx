import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import EyeToggleBtn from '../components/EyeToggleBtn.jsx';

describe('EyeToggleBtn', () => {
  it('calls onToggle on click', () => {
    const onToggle = vi.fn();
    render(<EyeToggleBtn visible={false} onToggle={onToggle} />);

    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
