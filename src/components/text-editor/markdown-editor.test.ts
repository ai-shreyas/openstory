import { describe, expect, it } from 'vitest';
import {
  plainTextPasteAsMarkdown,
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

  it('defers plain-text-only paste to the markdown clipboard parser', () => {
    expect(plainTextPasteAsMarkdown('', '# Heading')).toBeNull();
  });

  it('defers image-only / non-text paste to the default handler', () => {
    expect(plainTextPasteAsMarkdown('<img src="x">', '')).toBeNull();
  });
});
