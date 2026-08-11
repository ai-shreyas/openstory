import { describe, expect, it } from 'vitest';
import {
  plainTextPasteAsMarkdown,
  screenplayTextToJsonContent,
  toHardBreakMarkdown,
} from './markdown-editor';

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

describe('screenplayTextToJsonContent', () => {
  it('turns single newlines into hardBreak nodes within one paragraph', () => {
    expect(screenplayTextToJsonContent('INT. ROOM\nA man enters.')).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'INT. ROOM' },
          { type: 'hardBreak' },
          { type: 'text', text: 'A man enters.' },
        ],
      },
    ]);
  });

  it('splits blank lines into separate paragraphs', () => {
    expect(screenplayTextToJsonContent('Scene one.\n\nScene two.')).toEqual([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Scene one.' }],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Scene two.' }],
      },
    ]);
  });
});
