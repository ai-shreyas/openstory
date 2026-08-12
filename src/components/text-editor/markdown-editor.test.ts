import { describe, expect, it } from 'vitest';
import {
  normalizeScreenplayNewlines,
  plainTextPasteAsMarkdown,
  toHardBreakMarkdown,
} from './markdown-editor';

describe('normalizeScreenplayNewlines', () => {
  it('converts CRLF and CR to LF', () => {
    expect(normalizeScreenplayNewlines('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('converts Unicode line/paragraph separators to LF', () => {
    expect(normalizeScreenplayNewlines('Scene 1\u2028Body\u2029Scene 2')).toBe(
      'Scene 1\nBody\nScene 2'
    );
  });
});

describe('toHardBreakMarkdown', () => {
  it('converts single newlines to markdown hard breaks', () => {
    expect(toHardBreakMarkdown('INT. ROOM\nA man enters.')).toBe(
      'INT. ROOM  \nA man enters.'
    );
  });

  it('leaves paragraph-separating blank lines intact', () => {
    expect(toHardBreakMarkdown('Scene one.\n\nScene two.')).toBe(
      'Scene one.\n\nScene two.'
    );
  });

  it('handles mixed single and double newlines', () => {
    expect(toHardBreakMarkdown('a\nb\n\nc')).toBe('a  \nb\n\nc');
  });

  it('normalizes Unicode line separators before hard-break conversion', () => {
    expect(toHardBreakMarkdown('Scene 1\u2028Body')).toBe('Scene 1  \nBody');
  });
});

describe('plainTextPasteAsMarkdown', () => {
  it('coerces rich (text/html) paste to its plain-text markdown form', () => {
    const html = '<p style="color:red"><b>Bold</b> line</p>';
    expect(plainTextPasteAsMarkdown(html, 'Bold line')).toBe('Bold line');
  });

  it('strips styling but preserves multi-line structure as hard breaks', () => {
    const html = '<h1>Title</h1><p>Body</p>';
    expect(plainTextPasteAsMarkdown(html, 'Title\nBody')).toBe('Title  \nBody');
  });

  it('uses plain text even when HTML is empty (still coerces newlines)', () => {
    expect(plainTextPasteAsMarkdown('', '# Heading\nline')).toBe(
      '# Heading  \nline'
    );
  });

  it('defers image-only / non-text paste to the default handler', () => {
    expect(plainTextPasteAsMarkdown('<img src="x">', '')).toBeNull();
  });
});
