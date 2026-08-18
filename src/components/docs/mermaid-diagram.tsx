import { useEffect, useId, useState } from 'react';

type MermaidDiagramProps = {
  source: string;
};

let initialized = false;
let initializedTheme: 'default' | 'dark' | null = null;

async function ensureInitialized(theme: 'default' | 'dark') {
  const { default: mermaid } = await import('mermaid');
  if (!initialized || initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
    });
    initialized = true;
    initializedTheme = theme;
  }
  return mermaid;
}

function getPreferredTheme(): 'default' | 'dark' {
  if (typeof window === 'undefined') return 'default';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'default';
}

export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ source }) => {
  const reactId = useId();
  const diagramId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<'default' | 'dark'>(getPreferredTheme);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (event: MediaQueryListEvent) => {
      setTheme(event.matches ? 'dark' : 'default');
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    void (async () => {
      try {
        const mermaid = await ensureInitialized(theme);
        const { svg: rendered } = await mermaid.render(diagramId, source);
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- mutated by cleanup
        if (!cancelled) setSvg(rendered);
      } catch (err) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- mutated by cleanup
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, theme, diagramId]);

  if (error) {
    return (
      <div className="my-4 rounded-md border border-destructive/50 bg-destructive/5 p-4">
        <p className="mb-2 text-sm font-medium text-destructive">
          Failed to render diagram: {error}
        </p>
        <pre className="overflow-x-auto text-xs">
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      className="my-4 flex justify-center overflow-x-auto"
      // mermaid.render + securityLevel: 'strict' is the trusted SVG source.
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
};
