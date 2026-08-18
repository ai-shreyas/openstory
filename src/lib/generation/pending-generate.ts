/**
 * Pending-generate intent (#1187).
 *
 * When an anonymous visitor clicks Generate, the auth gate interrupts with
 * the sign-in dialog. Remember the click here (localStorage, next to the
 * draft it belongs with) so the composer can pick the flow back up — enhance
 * nudge, billing gate, generation — as soon as the user is signed in, whether
 * sign-in finished in-dialog (OTP) or via a full OAuth redirect. Short
 * expiry: resuming a minutes-old click is helpful, resuming a stale one fires
 * a generation the user no longer expects.
 */
const STORAGE_KEY = 'openstory:pending-generate';
const EXPIRY_MS = 10 * 60 * 1000;

export function markPendingGenerate(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    // localStorage unavailable — the user just clicks Generate again.
  }
}

/** Non-consuming peek. True when a fresh pending Generate click is stored —
 *  lets the welcome-credits dialog adapt its CTA without eating the intent. */
export function hasPendingGenerate(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return false;
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() - at <= EXPIRY_MS;
  } catch {
    return false;
  }
}

/** Read-and-clear. True when a fresh pending Generate click was stored. */
export function takePendingGenerate(): boolean {
  const pending = hasPendingGenerate();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable — nothing stored to clear.
  }
  return pending;
}
