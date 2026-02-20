import { describe, expect, it, beforeEach } from 'vitest';
import { clearUserMasterKey, getUserMasterKey, setUserMasterKey } from '../firebase.js';

describe('user master key lifecycle', () => {
  beforeEach(() => {
    clearUserMasterKey();
  });

  it('stores an internal copy and clears it on demand', () => {
    const key = new Uint8Array([1, 2, 3, 4]);
    setUserMasterKey(key);

    const stored = getUserMasterKey();
    expect(stored).toBeInstanceOf(Uint8Array);
    expect(stored).not.toBe(key);
    expect(Array.from(stored)).toEqual([1, 2, 3, 4]);

    clearUserMasterKey();
    expect(getUserMasterKey()).toBeNull();
    expect(Array.from(stored)).toEqual([0, 0, 0, 0]);
  });

  it('zeroizes the previous key when replacing it', () => {
    setUserMasterKey(new Uint8Array([9, 9, 9]));
    const previous = getUserMasterKey();

    setUserMasterKey(new Uint8Array([7, 7, 7]));
    expect(Array.from(previous)).toEqual([0, 0, 0]);
    expect(Array.from(getUserMasterKey())).toEqual([7, 7, 7]);
  });
});
