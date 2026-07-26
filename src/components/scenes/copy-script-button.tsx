/**
 * Copy the whole script — the composed document (#1037).
 *
 * The script document is rendered as one block per scene, so there is no single
 * element to select-all across. This copies `getComposedScriptFn`'s output: the
 * selected scene versions joined in order — exactly the text the blocks show,
 * and exactly what a re-analysis would consume.
 */

import { Button } from '@/components/ui/button';
import { useComposedScript } from '@/hooks/use-scenes';
import { Check, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

export const CopyScriptButton: React.FC<{ sequenceId: string }> = ({
  sequenceId,
}) => {
  const { data: composed } = useComposedScript(sequenceId);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const script = composed?.script ?? '';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
    } catch (error) {
      toast.error('Failed to copy script', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={!script}
      onClick={() => void handleCopy()}
      aria-label="Copy the whole script"
    >
      {copied ? (
        <Check className="mr-1.5 h-3.5 w-3.5" />
      ) : (
        <CopyIcon className="mr-1.5 h-3.5 w-3.5" />
      )}
      {copied ? 'Copied' : 'Copy script'}
    </Button>
  );
};
