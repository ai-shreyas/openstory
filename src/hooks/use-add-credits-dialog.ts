/**
 * Add Credits Dialog Store (#1099)
 *
 * Opens the single globally-mounted AddCreditsDialog. Callers: the sidebar
 * wallet pill, the billing gate's "Add credits" card, billing settings, the
 * welcome dialog, and the pricing page CTA.
 */

import { createDialogStore } from './create-dialog-store';

const store = createDialogStore();

export const openAddCreditsDialog = store.open;
export const closeAddCreditsDialog = store.close;
export const useAddCreditsDialogOpen = store.useIsOpen;
