import { describe, expect, it } from 'vitest';
import { isPermissionMutedIn } from './permissionMute';

describe('isPermissionMutedIn', () => {
  it('a person is muted by the per-space key in whatever channel the row is', () => {
    const muted = new Set(['s1:u1']);
    expect(isPermissionMutedIn(muted, 's1', 'u1', 'c1')).toBe(true);
    expect(isPermissionMutedIn(muted, 's1', 'u1', null)).toBe(true);
    expect(isPermissionMutedIn(muted, 's1', 'u2', 'c1')).toBe(false);
  });

  it('a bot seat mute shows only in its own channel', () => {
    const muted = new Set(['s1:bot:cA']);
    expect(isPermissionMutedIn(muted, 's1', 'bot', 'cA')).toBe(true);
    expect(isPermissionMutedIn(muted, 's1', 'bot', 'cB')).toBe(false);
    expect(isPermissionMutedIn(muted, 's1', 'bot', null)).toBe(false);
  });

  it('without a space nothing is muted', () => {
    expect(isPermissionMutedIn(new Set(['undefined:u1']), undefined, 'u1', 'c1')).toBe(false);
  });
});
