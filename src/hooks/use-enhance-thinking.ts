/**
 * "Extended thinking" preference for script enhancement.
 *
 * The enhance call streams straight to a waiting user, so the model's reasoning
 * pass is off by default — it delays the first token noticeably. This toggle
 * lets the user buy that latency back when a script needs real structural
 * invention rather than a competent expansion.
 *
 * localStorage-backed so the choice survives a reload, hydrated after mount:
 * SSR renders the default (off), so the first client render matches the server
 * and there is no hydration mismatch.
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'openstory:enhance-thinking';

/** Product default — fast path; the user opts into the slower, deeper run. */
const DEFAULT_THINKING = false;

export function useEnhanceThinking() {
  const [thinking, setThinkingState] = useState(DEFAULT_THINKING);

  useEffect(() => {
    try {
      setThinkingState(localStorage.getItem(STORAGE_KEY) === 'true');
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
