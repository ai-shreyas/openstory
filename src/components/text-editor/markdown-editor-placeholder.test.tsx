import { MarkdownEditor } from '@/components/text-editor/markdown-editor';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

describe('MarkdownEditor empty placeholder', () => {
  it('SSRs the placeholder as a real <p> so LCP does not wait for TipTap', () => {
    const html = renderToStaticMarkup(
      <MarkdownEditor
        value=""
        onValueChange={() => undefined}
        placeholder="A one-liner is enough"
      />
    );
    expect(html).toContain('A one-liner is enough');
    expect(html).toContain('<p');
  });

  it('does not SSR the placeholder over seeded content', () => {
    const html = renderToStaticMarkup(
      <MarkdownEditor
        value="INT. ROOM - NIGHT"
        onValueChange={() => undefined}
        placeholder="A one-liner is enough"
      />
    );
    expect(html).not.toContain('A one-liner is enough');
  });
});
