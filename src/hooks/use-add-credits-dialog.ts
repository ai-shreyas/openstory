/**
 * Add Credits Dialog Store
 *
 * Module store + useSyncExternalStore (same pattern as useShowBalance) so any
 * surface — sidebar Pricing, the billing gate, settings, toast actions — can
 * open the single globally-mounted AddCreditsDialog (#1099).
 */

import { useSyncExternalStore } from 'react';

let isOpen = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openAddCreditsDialog() {
  isOpen = true;
  emit();
}

export function closeAddCreditsDialog() {
  isOpen = false;
  emit();
}

export function useAddCreditsDialogOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isOpen,
    () => false
  );
}
