/**
 * "Extended thinking" preference for script enhancement.
 *
 * ON by default: the reasoning pass is what escapes the modal/obvious expansion
 * (#870/#875), and that matters most where enhancement is weakest — budgeting a
 * story across enough scenes to fill the target duration. The toggle exists for
 * the times the user wants text on screen now and will take a competent
 * expansion over a considered one.
 *
 * localStorage-backed so the choice survives a reload, hydrated after mount:
 * SSR renders the default, so the first client render matches the server and
 * there is no hydration mismatch.
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'openstory:enhance-thinking';

/** Product default — the considered run; the user opts out for speed. */
const DEFAULT_THINKING = true;

export function useEnhanceThinking() {
  const [thinking, setThinkingState] = useState(DEFAULT_THINKING);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // Only an explicit "false" turns it off — an absent key keeps the default.
      if (raw !== null) setThinkingState(raw === 'true');
    } catch {
      // private mode / storage disabled — keep the default
    }
  }, []);

  const setThinking = useCallback((value: boolean) => {
    setThinkingState(value);
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // private mode / quota — the in-memory value still applies to this run
    }
  }, []);

  return { thinking, setThinking };
}
