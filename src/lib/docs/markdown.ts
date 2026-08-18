import { parseMarkdown } from '@tanstack/markdown/parser';
import { headingCollectionExtension } from '@tanstack/markdown/extensions/headings';
import type {
  BlockNode,
  ComponentNode,
  MarkdownDocument,
  MarkdownExtension,
  MarkdownHeading,
} from '@tanstack/markdown';

export type { MarkdownDocument };

export type RenderedMarkdown = {
  document: MarkdownDocument;
  headings: MarkdownHeading[];
};

function mermaidComponent(source: string): ComponentNode {
  return {
    type: 'component',
    name: 'mermaid',
    tagName: 'mermaid-diagram',
    attributes: { source },
    properties: { source },
    children: [],
  };
}

function rewriteMermaidFences(blocks: BlockNode[]): BlockNode[] {
  return blocks.map((block) => {
    if (block.type === 'code' && block.lang === 'mermaid') {
      return mermaidComponent(block.value);
    }
    if (block.type === 'list') {
      return {
        ...block,
        items: block.items.map((item) => ({
          ...item,
          children: rewriteMermaidFences(item.children),
        })),
      };
    }
    if (block.type === 'blockquote' || block.type === 'callout') {
      return { ...block, children: rewriteMermaidFences(block.children) };
    }
    if (block.type === 'component') {
      return { ...block, children: rewriteMermaidFences(block.children) };
    }
    if (block.type === 'footnotes') {
      return {
        ...block,
        items: block.items.map((item) => ({
          ...item,
          children: rewriteMermaidFences(item.children),
        })),
      };
    }
    return block;
  });
}

/**
 * Turns ```mermaid fences into `mermaid-diagram` component nodes so the
 * React renderer can mount the client SVG without a highlighter pass.
 */
function mermaidFenceExtension(): MarkdownExtension {
  return {
    name: 'mermaid-fences',
    transformDocument(document) {
      return {
        ...document,
        children: rewriteMermaidFences(document.children),
      };
    },
  };
}

const parseExtensions: MarkdownExtension[] = [
  mermaidFenceExtension(),
  headingCollectionExtension(),
];

/**
 * Parse docs markdown to a serializable TanStack AST + TOC headings.
 * Frontmatter is already stripped by content-collections.
 */
export function parseDocsMarkdown(content: string): RenderedMarkdown {
  const document = parseMarkdown(content, {
    frontmatter: false,
    extensions: parseExtensions,
  });
  return {
    document,
    headings: document.headings ?? [],
  };
}

export function isInternalDocsHref(href: string): boolean {
  return href.startsWith('/');
}
