/**
 * html-dom-parser@8 ships ESM as `export { HTMLDOMParser as default }` but its
 * .d.mts only lists a named export. Default is the correct runtime import for
 * Vite/rolldown (named fails with MISSING_EXPORT). Align types with the ESM.
 */
declare module 'html-dom-parser/lib/server/html-to-dom' {
  import type { DOMNode } from 'html-dom-parser';

  export default function HTMLDOMParser(
    html: string,
    options?: unknown
  ): DOMNode[];
}
