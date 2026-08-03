/**
 * Billing Gate Dialog Store (#1099)
 *
 * Module store + useSyncExternalStore so the globally-mounted gate dialog can
 * be opened from anywhere — including the query client's global mutation
 * error handler, which opens it on INSUFFICIENT_CREDITS errors. Kept free of
 * app imports so `query-client.ts` can depend on it without cycles.
 */

import { useSyncExternalStore } from 'react';

type GateState = { open: boolean };

let state: GateState = { open: false };
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

export function openBillingGate() {
  if (state.open) return;
  state = { open: true };
  emit();
}

export function closeBillingGate() {
  if (!state.open) return;
  state = { open: false };
  emit();
}

export function useBillingGateDialogOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => state.open,
    () => false
  );
}
