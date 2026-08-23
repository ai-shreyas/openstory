import { describe, expect, it } from 'vitest';
import { selectFilesToAccept } from './element-selector';
import { MAX_SEQUENCE_ELEMENTS } from '@/lib/sequence-elements/limits';

const file = (name: string) => new File([], name);
const keyByName = (f: File) => f.name;

describe('selectFilesToAccept', () => {
  it('accepts new files and skips duplicates (existing and within the batch)', () => {
    const accepted = selectFilesToAccept(
      [file('a'), file('b'), file('a'), file('c')],
      new Set(['b']),
      1,
      keyByName
    );
    expect(accepted.map((e) => e.key)).toEqual(['a', 'c']);
  });

  it('caps at MAX_SEQUENCE_ELEMENTS counting existing elements', () => {
    const files = Array.from({ length: MAX_SEQUENCE_ELEMENTS }, (_, i) =>
      file(`f${i}`)
    );
    const accepted = selectFilesToAccept(
      files,
      new Set(),
      MAX_SEQUENCE_ELEMENTS - 2,
      keyByName
    );
    expect(accepted).toHaveLength(2);
  });

  it('accepts nothing when already at the cap', () => {
    expect(
      selectFilesToAccept(
        [file('a')],
        new Set(),
        MAX_SEQUENCE_ELEMENTS,
        keyByName
      )
    ).toEqual([]);
  });
});
