import { beforeEach, describe, expect, it } from 'vitest';
import {
  developerModeKey,
  readDeveloperMode,
  useDeveloperModeStore,
  writeDeveloperMode,
} from './developerModeStore';

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
  };
}

const throwingStorage: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
};

describe('developer mode storage helpers', () => {
  it('is off by default and for no user', () => {
    expect(readDeveloperMode(memoryStorage(), 'u1')).toBe(false);
    expect(readDeveloperMode(memoryStorage(), null)).toBe(false);
  });

  it('keeps the switch per user id', () => {
    const storage = memoryStorage();
    writeDeveloperMode(storage, 'u1', true);
    expect(readDeveloperMode(storage, 'u1')).toBe(true);
    expect(readDeveloperMode(storage, 'u2')).toBe(false);
    writeDeveloperMode(storage, 'u1', false);
    expect(readDeveloperMode(storage, 'u1')).toBe(false);
  });

  it('survives a storage that throws', () => {
    expect(readDeveloperMode(throwingStorage, 'u1')).toBe(false);
    expect(() => writeDeveloperMode(throwingStorage, 'u1', true)).not.toThrow();
  });
});

describe('useDeveloperModeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useDeveloperModeStore.getState().reset();
  });

  it('ignores a switch before a user is known', () => {
    useDeveloperModeStore.getState().setEnabled(true);
    expect(useDeveloperModeStore.getState().enabled).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('writes the switch under the signed-in user and reads it back after a reload', () => {
    const store = useDeveloperModeStore.getState();
    store.setUser('u1');
    store.setEnabled(true);
    expect(localStorage.getItem(developerModeKey('u1'))).toBe('1');

    useDeveloperModeStore.getState().reset();
    expect(useDeveloperModeStore.getState().enabled).toBe(false);
    useDeveloperModeStore.getState().setUser('u1');
    expect(useDeveloperModeStore.getState().enabled).toBe(true);
  });

  it('does not carry the switch over to another account', () => {
    const store = useDeveloperModeStore.getState();
    store.setUser('u1');
    store.setEnabled(true);
    useDeveloperModeStore.getState().setUser('u2');
    expect(useDeveloperModeStore.getState().enabled).toBe(false);
  });
});
