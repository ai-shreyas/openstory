// Structural fakes stand in for DOM nodes (no jsdom in the unit env).
/* oxlint-disable typescript/no-unsafe-type-assertion */
import { describe, expect, it, vi } from 'vitest';
import { installTranslateGuard } from './translate-guard';

describe('installTranslateGuard', () => {
  it('passes owned children through and no-ops on detached ones', () => {
    const removeChild = vi.fn((c: Node) => c);
    const insertBefore = vi.fn((n: Node, _ref: Node | null) => n);
    const proto = { removeChild, insertBefore };
    installTranslateGuard(proto as unknown as Node);

    const parent = {} as Node;
    const owned = { parentNode: parent } as Node;
    const foreign = { parentNode: {} } as Node;
    const fresh = { parentNode: null } as Node;

    expect(proto.removeChild.call(parent, owned)).toBe(owned);
    expect(removeChild).toHaveBeenCalledWith(owned);
    expect(proto.removeChild.call(parent, foreign)).toBe(foreign);
    expect(removeChild).toHaveBeenCalledTimes(1);

    proto.insertBefore.call(parent, fresh, owned);
    expect(insertBefore).toHaveBeenLastCalledWith(fresh, owned);
    proto.insertBefore.call(parent, fresh, foreign);
    expect(insertBefore).toHaveBeenLastCalledWith(fresh, null);
  });
});
