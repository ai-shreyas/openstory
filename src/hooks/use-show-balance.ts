/**
 * Show Balance Preference Hook
 *
 * localStorage-backed toggle for always showing the credit balance in the
 * sidebar. Module store + useSyncExternalStore so the credits-page switch and
 * CreditBalancePill stay in sync without a reload (same pattern as
 * useActiveVideoModel).
 */

import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'openstory:show-balance';

/** `undefined` = not yet hydrated from localStorage. */
let cached: boolean | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

let storageListenerAttached = false;
function ensureStorageListener() {
  if (storageListenerAttached || typeof window === 'undefined') return;
  storageListenerAttached = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    cached = event.newValue === 'true';
    emit();
  });
}

function subscribe(listener: () => void) {
  ensureStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function hydrate(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function read(): boolean {
  if (cached !== undefined) return cached;
  const value = hydrate();
  cached = value;
  return value;
}

function write(value: boolean) {
  cached = value;
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // private mode / quota — keep in-memory value
    }
  }
  emit();
}

export function useShowBalance() {
  const showBalance = useSyncExternalStore(subscribe, read, () => false);

  const setShowBalance = useCallback((value: boolean) => {
    write(value);
  }, []);

  return { showBalance, setShowBalance };
}
