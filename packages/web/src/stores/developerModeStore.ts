import { create } from 'zustand';

/**
 * Developer Mode: a per-account, per-browser switch that shows developer tools
 * (today the Bots tab) in settings. It only hides or shows UI. The API behind
 * those tools stays available either way, so this is not a security boundary.
 *
 * Stored per user id, following `utils/updateAck.ts`, so two accounts sharing a
 * browser do not switch each other's tools on. Every access is wrapped: a
 * browser in private mode throws on storage access, and the right failure there
 * is a switch that lasts until the page reloads.
 */

const KEY_PREFIX = 'backspace_developer_mode';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function developerModeKey(userId: string): string {
  return `${KEY_PREFIX}_${userId}`;
}

export function readDeveloperMode(storage: Store, userId: string | null): boolean {
  if (userId === null) return false;
  try {
    return storage.getItem(developerModeKey(userId)) === '1';
  } catch {
    return false;
  }
}

export function writeDeveloperMode(storage: Store, userId: string, enabled: boolean): void {
  try {
    storage.setItem(developerModeKey(userId), enabled ? '1' : '0');
  } catch {
    /* private mode: the switch lasts until the page reloads */
  }
}

interface DeveloperModeState {
  /** Whose switch `enabled` is. Null before sign-in and after sign-out. */
  userId: string | null;
  enabled: boolean;
  setUser: (userId: string | null) => void;
  setEnabled: (enabled: boolean) => void;
  reset: () => void;
}

export const useDeveloperModeStore = create<DeveloperModeState>((set, get) => ({
  userId: null,
  enabled: false,
  setUser: (userId) => set({ userId, enabled: readDeveloperMode(localStorage, userId) }),
  setEnabled: (enabled) => {
    const { userId } = get();
    if (userId === null) return;
    writeDeveloperMode(localStorage, userId, enabled);
    set({ enabled });
  },
  reset: () => set({ userId: null, enabled: false }),
}));
