import { describe, expect, it, vi } from 'vitest';
import { FANOUT_CONCURRENCY, mapWithConcurrency } from './fanout';

describe('FANOUT_CONCURRENCY', () => {
  it('exposes positive caps', () => {
    expect(FANOUT_CONCURRENCY.image).toBeGreaterThan(0);
    expect(FANOUT_CONCURRENCY.variantTrigger).toBeGreaterThan(0);
    expect(FANOUT_CONCURRENCY.sheet).toBeGreaterThan(0);
    expect(FANOUT_CONCURRENCY.motion).toBeGreaterThan(0);
  });
});

describe('mapWithConcurrency', () => {
  it('returns empty for empty input', async () => {
    const fn = vi.fn();
    await expect(mapWithConcurrency([], 4, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs every item and returns results in INPUT order', async () => {
    // Reverse-staggered delays: completion order is the opposite of input
    // order, so this fails if results are collected as they settle.
    const items = [40, 30, 20, 10, 0];
    const results = await mapWithConcurrency(items, 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });

    expect(results).toEqual(
      items.map((ms) => ({ status: 'fulfilled', value: ms }))
    );
  });

  it('captures rejections per item without poisoning peers', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });

    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
  });

  it('never exceeds the concurrency ceiling', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      }
    );

    expect(peak).toBe(3);
  });

  /**
   * The point of #1143: a wave barrier would idle every other worker while one
   * slow item finishes its slice. A rolling window must start the next item as
   * soon as ANY slot frees, so a single slow item cannot gate its peers.
   */
  it('starts queued work while a slow item is still running', async () => {
    const started: number[] = [];

    await mapWithConcurrency([100, 0, 0, 0, 0], 2, async (ms, index) => {
      started.push(index);
      await new Promise((r) => setTimeout(r, ms));
    });

    // Item 0 blocks its slot for the whole run; 1..4 must all have started
    // through the other slot rather than waiting for a barrier.
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it('treats Infinity as start-everything', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 8 }, (_, i) => i),
      Number.POSITIVE_INFINITY,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      }
    );

    expect(peak).toBe(8);
  });
});
