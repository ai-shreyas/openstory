import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { cn } from '@/lib/utils';
import { Brain, ChevronRight } from 'lucide-react';
import { useEffect, useState, type FC } from 'react';

/**
 * The model's thinking, streamed live while a script is being enhanced.
 *
 * Enhancement runs a reasoning pass before it writes a word, which used to
 * leave the editor dead for many seconds. Showing the reasoning turns that wait
 * into visible progress — and it is genuinely interesting: the plan for the
 * script is being made in front of the user.
 *
 * Open while thinking, collapsed the moment the script starts arriving (the
 * script is the point; the thinking becomes reference). It stays available
 * afterwards behind a "Thought for Ns" summary, until the next enhance.
 */
export const EnhanceThinking: FC<{
  /** Reasoning text so far. Empty renders nothing. */
  text: string;
  /** Whether the reasoning pass is still streaming. */
  active: boolean;
  /** Seconds the pass took, once it has finished. */
  elapsedSeconds: number | null;
}> = ({ text, active, elapsedSeconds }) => {
  const [open, setOpen] = useState(true);
  const [userToggled, setUserToggled] = useState(false);

  // Collapse when the model stops thinking and starts writing — unless the user
  // has taken control of the panel, in which case their choice sticks.
  useEffect(() => {
    if (!active && !userToggled) setOpen(false);
  }, [active, userToggled]);

  const { ref } = useAutoScroll<HTMLDivElement>({
    enabled: active && open,
    content: text,
  });

  if (!text) return null;

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setUserToggled(true);
        setOpen(next);
      }}
      className="flex flex-col gap-2 rounded-md border bg-muted/40 px-3 py-2"
    >
      {/* Not CollapsibleTrigger: that renders a bare <button>, and this needs
          the shared focus ring + hit target of a real control row. */}
      <button
        type="button"
        onClick={() => {
          setUserToggled(true);
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="flex min-h-6 items-center gap-2 rounded-sm text-left text-sm text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
        <Brain
          className={cn(
            'size-3.5 shrink-0 text-primary',
            active && 'animate-pulse motion-reduce:animate-none'
          )}
        />
        {/* The status line is the live region, not the transcript below: a
            token-by-token stream through aria-live would flood a screen reader
            with scratch work. */}
        <span aria-live="polite">
          {active
            ? 'Thinking…'
            : elapsedSeconds !== null
              ? `Thought for ${elapsedSeconds}s`
              : 'Thinking'}
        </span>
      </button>
      <CollapsibleContent>
        <div
          ref={ref}
          aria-busy={active}
          className="max-h-32 overflow-y-auto text-sm whitespace-pre-wrap text-muted-foreground"
        >
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
