/**
 * Pending composer intent (#1187, #1286).
 *
 * When an anonymous visitor clicks Generate or Enhance Script, the auth gate
 * interrupts with the sign-in dialog. Remember the click here (localStorage,
 * next to the draft it belongs with) so the composer can pick the flow back
 * up — enhance, billing gate, generation — as soon as the user is signed in,
 * whether sign-in finished in-dialog (OTP) or via a full OAuth redirect.
 * Short expiry: resuming a minutes-old click is helpful, resuming a stale
 * one fires a generation the user no longer expects.
 */
const STORAGE_KEY = 'openstory:pending-generate';
const EXPIRY_MS = 10 * 60 * 1000;

export type PendingIntent = 'generate' | 'enhance';

type StoredIntent = {
  action: PendingIntent;
  at: number;
};

function readStored(): StoredIntent | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    // Legacy #1187: a bare timestamp meant "Generate".
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && !raw.trim().startsWith('{')) {
      return { action: 'generate', at: asNum };
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'action' in parsed &&
      'at' in parsed
    ) {
      const action = parsed.action;
      const at = Number(parsed.at);
      if (
        (action === 'generate' || action === 'enhance') &&
        Number.isFinite(at)
      ) {
        return { action, at };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isFresh(stored: StoredIntent): boolean {
  return Date.now() - stored.at <= EXPIRY_MS;
}

export function markPendingIntent(action: PendingIntent): void {
  if (typeof window === 'undefined') return;
  try {
    const stored: StoredIntent = { action, at: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // localStorage unavailable — the user just clicks again.
  }
}

export function markPendingGenerate(): void {
  markPendingIntent('generate');
}

/** Non-consuming peek. True when a fresh pending Generate/Enhance click is
 *  stored — lets the welcome-credits dialog adapt its CTA without eating
 *  the intent. */
export function hasPendingGenerate(): boolean {
  const stored = readStored();
  return stored != null && isFresh(stored);
}

export function peekPendingIntent(): PendingIntent | null {
  const stored = readStored();
  if (!stored || !isFresh(stored)) return null;
  return stored.action;
}

/** Read-and-clear. The action to resume, or null if nothing fresh is stored. */
export function takePendingIntent(): PendingIntent | null {
  const action = peekPendingIntent();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable — nothing stored to clear.
  }
  return action;
}
