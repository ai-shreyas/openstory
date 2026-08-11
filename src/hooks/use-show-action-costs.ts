/**
 * Show Action Costs Preference Hook (#1140)
 *
 * localStorage-backed toggle for showing likely generation cost under
 * action buttons (Generate, Generate Image, …). Default ON — transparent
 * pricing is the product default; users can silence it next to the
 * "show balance" wallet preference.
 *
 * Module store + useSyncExternalStore so billing settings, the welcome
 * dialog, and every ActionCost stay in sync without a reload (same
 * pattern as useShowBalance).
 */

import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'openstory:show-action-costs';
const DEFAULT_SHOW_ACTION_COSTS = true;

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
    cached = parseStored(event.newValue);
    emit();
  });
}

function parseStored(raw: string | null): boolean {
  // Missing key → default ON. Explicit "false" / "true" win.
  if (raw === null) return DEFAULT_SHOW_ACTION_COSTS;
  return raw === 'true';
}

function subscribe(listener: () => void) {
  ensureStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function hydrate(): boolean {
  if (typeof window === 'undefined') return DEFAULT_SHOW_ACTION_COSTS;
  try {
    return parseStored(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_SHOW_ACTION_COSTS;
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

export function useShowActionCosts() {
  const showActionCosts = useSyncExternalStore(
    subscribe,
    read,
    () => DEFAULT_SHOW_ACTION_COSTS
  );

  const setShowActionCosts = useCallback((value: boolean) => {
    write(value);
  }, []);

  return { showActionCosts, setShowActionCosts };
}
