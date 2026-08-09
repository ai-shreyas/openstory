import { describe, expect, it, vi } from 'vitest';
import { FANOUT_CONCURRENCY, mapInWaves } from './map-in-waves';

describe('FANOUT_CONCURRENCY', () => {
  it('exposes positive caps', () => {
    expect(FANOUT_CONCURRENCY.image).toBeGreaterThan(0);
    expect(FANOUT_CONCURRENCY.variantTrigger).toBeGreaterThan(0);
    expect(FANOUT_CONCURRENCY.sheet).toBeGreaterThan(0);
    expect(FANOUT_CONCURRENCY.motion).toBeGreaterThan(0);
  });
});

describe('mapInWaves', () => {
  it('returns empty for empty input', async () => {
    const fn = vi.fn();
    await expect(mapInWaves([], 4, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs all items and preserves order of settled results', async () => {
    const results = await mapInWaves([10, 20, 30], 2, async (n) => n * 2);
    expect(results).toEqual([
      { status: 'fulfilled', value: 20 },
      { status: 'fulfilled', value: 40 },
      { status: 'fulfilled', value: 60 },
    ]);
  });

  it('isolates failures within a wave (allSettled)', async () => {
    const results = await mapInWaves([1, 2, 3], 3, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(results[1]?.status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
  });

  it('never runs more than concurrency jobs at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapInWaves(items, 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });

  it('treats concurrency < 1 as 1', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapInWaves([1, 2, 3], 0, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
    });
    expect(peak).toBe(1);
  });

  it('passes the global index (not wave-local) to fn', async () => {
    const indexes: number[] = [];
    await mapInWaves(['a', 'b', 'c', 'd'], 2, async (_item, index) => {
      indexes.push(index);
    });
    expect(indexes).toEqual([0, 1, 2, 3]);
  });

  it('starts the next wave only after the previous settles', async () => {
    const started: number[] = [];
    const finished: number[] = [];

    await mapInWaves([0, 1, 2, 3], 2, async (n) => {
      started.push(n);
      await new Promise((r) => setTimeout(r, 10));
      finished.push(n);
    });

    // First wave must fully finish before second wave starts any work.
    const byNum = (a: number, b: number) => a - b;
    expect(finished.slice(0, 2).sort(byNum)).toEqual([0, 1]);
    expect(started.slice(0, 2).sort(byNum)).toEqual([0, 1]);
    expect(started.indexOf(2)).toBeGreaterThanOrEqual(2);
    expect(started.indexOf(3)).toBeGreaterThanOrEqual(2);
  });
});
