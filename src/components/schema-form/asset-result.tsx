/**
 * Renders one `generated_assets` run (#458): a skeleton while the workflow is
 * in flight, an error alert on failure, and the output media — image, video,
 * or audio by contentType — once completed. Output URLs are origin-relative
 * R2 (`/r2/<key>`, #894); `AppImage` routes same-zone images through
 * Cloudflare Image Transformations like the rest of the app.
 */

import { AppImage } from '@/components/ui/app-image';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import type { GeneratedAsset, GeneratedAssetOutput } from '@/lib/db/schema';
import { AlertCircle, FileIcon } from 'lucide-react';
import type { FC } from 'react';

const OutputMedia: FC<{ output: GeneratedAssetOutput; index: number }> = ({
  output,
  index,
}) => {
  if (output.contentType.startsWith('image/')) {
    return (
      <AppImage
        src={output.url}
        alt={`Generated image ${index + 1}`}
        width={768}
        height={768}
        className="max-h-[60vh] w-auto max-w-full rounded-lg border bg-muted object-contain"
      />
    );
  }
  if (output.contentType.startsWith('video/')) {
    return (
      <video
        src={output.url}
        controls
        playsInline
        className="block max-h-[60vh] w-auto max-w-full rounded-lg border bg-muted object-contain"
      >
        <track kind="captions" />
      </video>
    );
  }
  if (output.contentType.startsWith('audio/')) {
    return (
      <audio src={output.url} controls className="w-full max-w-md">
        <track kind="captions" />
      </audio>
    );
  }
  return (
    <a
      href={output.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex w-fit items-center gap-2 text-sm underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <FileIcon aria-hidden="true" className="size-4" />
      Download output {index + 1} ({output.contentType})
    </a>
  );
};

/**
 * One generated-asset run. Poll the asset via `getGeneratedAssetFn` and pass
 * each fresh row in; this component is purely presentational.
 */
export const AssetResult: FC<{ asset: GeneratedAsset }> = ({ asset }) => {
  if (asset.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>Generation failed</AlertTitle>
        <AlertDescription>
          {asset.error ?? 'The model run failed without an error message.'}
        </AlertDescription>
      </Alert>
    );
  }

  if (asset.status !== 'completed') {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="aspect-video w-full max-w-md rounded-lg" />
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {asset.status === 'queued' ? 'Queued…' : 'Generating…'}
        </p>
      </div>
    );
  }

  const outputs = asset.outputs ?? [];
  if (outputs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        The run completed but produced no output files.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {outputs.map((output, index) => (
        <OutputMedia key={output.url} output={output} index={index} />
      ))}
    </div>
  );
};
