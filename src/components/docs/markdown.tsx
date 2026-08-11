import { Link } from '@tanstack/react-router';
import type { DOMNode } from 'html-dom-parser';
// Import the htmlparser2 server build directly instead of the bare
// `html-dom-parser` entry (which html-react-parser's `parse()` uses).
// Workerd's resolve conditions include `browser`, so the bare entry resolves
// to the DOMParser client build — DOMParser doesn't exist in Workerd, the
// first SSR `parse()` throws, React aborts the shell to client rendering,
// and the docs ship an empty <body> (invisible to crawlers, #814). The
// server build is pure JS, so it runs everywhere and the client parses
// markup identically to the server (no hydration drift).
// Default import: ESM is `export { HTMLDOMParser as default }` (see
// src/types/html-dom-parser-server.d.ts). Named import fails at build time.
import htmlToDOM from 'html-dom-parser/lib/server/html-to-dom';
import {
  type HTMLReactParserOptions,
  attributesToProps,
  domToReact,
} from 'html-react-parser';
import { MermaidDiagram } from './mermaid-diagram';

type MarkdownContentProps = {
  markup: string;
  className?: string;
};

function isInternalLink(href: string): boolean {
  return href.startsWith('/');
}

function childrenToDOMNodes(children: readonly unknown[]): DOMNode[] {
  return children.filter(
    (child): child is DOMNode =>
      typeof child === 'object' &&
      child !== null &&
      'type' in child &&
      typeof child.type === 'string'
  );
}

const parserOptions: HTMLReactParserOptions = {
  replace(domNode) {
    // Use a structural check rather than `instanceof Element` because
    // duplicated domhandler module instances make the class identity
    // unreliable, leaving `instanceof` false for real Element nodes.
    if (domNode.type !== 'tag') return;

    // Render mermaid diagrams from server-emitted placeholders
    if (domNode.name === 'div' && domNode.attribs.class === 'mermaid-diagram') {
      const source = domNode.attribs['data-mermaid-source'] ?? '';
      return <MermaidDiagram source={source} />;
    }

    // Replace internal <a> links with TanStack Router <Link>
    if (domNode.name === 'a' && domNode.attribs.href) {
      const href = domNode.attribs.href;
      if (isInternalLink(href)) {
        const props = attributesToProps(domNode.attribs);
        return (
          <Link to={href} {...props}>
            {domToReact(childrenToDOMNodes(domNode.children), parserOptions)}
          </Link>
        );
      }
    }

    // Add loading="lazy" to images, ensure alt is always set
    if (domNode.name === 'img') {
      const { alt = '', ...rest } = attributesToProps(
        domNode.attribs
      ) as React.ImgHTMLAttributes<HTMLImageElement>;
      return <img {...rest} alt={alt} loading="lazy" />;
    }
  },
};

export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  markup,
  className,
}) => {
  return (
    <div className={`prose dark:prose-invert max-w-none ${className ?? ''}`}>
      {domToReact(
        // Matches html-react-parser's `parse()` defaults — it disables
        // attribute lowercasing so e.g. SVG viewBox survives.
        htmlToDOM(markup, { lowerCaseAttributeNames: false }),
        parserOptions
      )}
    </div>
  );
};
