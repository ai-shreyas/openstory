import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    mem.set(k, v);
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
};

describe('pending generate/enhance intent', () => {
  beforeEach(() => {
    mem.clear();
    vi.stubGlobal('window', { localStorage: localStorageMock });
    vi.stubGlobal('localStorage', localStorageMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('remembers a Generate click and consumes it once', async () => {
    const {
      markPendingGenerate,
      hasPendingGenerate,
      peekPendingIntent,
      takePendingIntent,
    } = await import('./pending-generate');

    expect(hasPendingGenerate()).toBe(false);
    markPendingGenerate();
    expect(hasPendingGenerate()).toBe(true);
    expect(peekPendingIntent()).toBe('generate');
    expect(takePendingIntent()).toBe('generate');
    expect(hasPendingGenerate()).toBe(false);
    expect(takePendingIntent()).toBeNull();
  });

  it('remembers an Enhance click separately from Generate', async () => {
    const { markPendingIntent, peekPendingIntent, takePendingIntent } =
      await import('./pending-generate');

    markPendingIntent('enhance');
    expect(peekPendingIntent()).toBe('enhance');
    expect(takePendingIntent()).toBe('enhance');
  });

  it('still reads a legacy timestamp as Generate', async () => {
    const { peekPendingIntent, hasPendingGenerate } =
      await import('./pending-generate');

    localStorage.setItem('openstory:pending-generate', String(Date.now()));
    expect(hasPendingGenerate()).toBe(true);
    expect(peekPendingIntent()).toBe('generate');
  });

  it('expires after ten minutes', async () => {
    const { markPendingIntent, peekPendingIntent } =
      await import('./pending-generate');

    markPendingIntent('enhance');
    vi.setSystemTime(new Date('2026-08-25T12:11:00Z'));
    expect(peekPendingIntent()).toBeNull();
  });
});
