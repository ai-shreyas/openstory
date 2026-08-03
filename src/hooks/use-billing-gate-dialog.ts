/**
 * Billing Gate Dialog Store (#1099)
 *
 * Opens the globally-mounted gate dialog from anywhere — including the query
 * client's global mutation error handler, which opens it on
 * INSUFFICIENT_CREDITS.
 */

import { createDialogStore } from './create-dialog-store';

const store = createDialogStore();

export const openBillingGate = store.open;
export const closeBillingGate = store.close;
export const useBillingGateDialogOpen = store.useIsOpen;
