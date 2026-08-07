import { getEnv } from '#env';
import { createFileRoute } from '@tanstack/react-router';
import { authRequestMiddleware } from '@/functions/middleware';

/**
 * SSE subscription endpoint. One request carries *many* channels: the client
 * opens a single `EventSource` for the union of everything it is subscribed to
 * (see `client.tsx`) and this handler fans that out to one `RealtimeChannel`
 * Durable Object per channel, merging their streams back into one response.
 *
 * The multiplexing is not an optimisation — it is required for correctness.
 * Browsers cap concurrent HTTP/1.1 connections per origin at 6, and an SSE
 * stream holds its connection for its entire life. One `EventSource` per
 * channel therefore deadlocked the whole origin as soon as a page rendered ~5
 * cards (each subscribing to its own channel) plus the billing pill: every
 * later request — route chunks, server functions, images — queued forever
 * behind the streams and the app silently stopped navigating (#827).
 */

/** Hard cap so one subscriber can't fan a single request out to unbounded DOs. */
const MAX_CHANNELS = 64;
/** Keepalive cadence for the merged stream. Sub-stream pings are filtered out. */
const PING_INTERVAL_MS = 25_000;

/** A DO frame is `data: {json}\n\n`; system frames carry `type` and stop here. */
function parseFrame(frame: string): unknown {
  const payload = frame.startsWith('data:') ? frame.slice(5).trim() : '';
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function isSystemEvent(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && 'type' in payload;
}

export const Route = createFileRoute('/api/realtime')({
  server: {
    middleware: [authRequestMiddleware],
    handlers: {
      GET: ({ request }) => {
        const params = new URL(request.url).searchParams;
        // `channel` (singular) is still accepted so a tab left open across a
        // deploy keeps streaming instead of erroring until the user reloads.
        const requested = params.get('channels') ?? params.get('channel') ?? '';
        const channels = [
          ...new Set(
            requested
              .split(',')
              .map((channel) => channel.trim())
              .filter(Boolean)
          ),
        ].slice(0, MAX_CHANNELS);

        if (channels.length === 0) {
          return new Response('missing channels', { status: 400 });
        }

        // getEnv()'s type is platform-dependent; the Cloudflare runtime
        // guarantees the Cloudflare.Env shape with the REALTIME binding.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- platform-dependent env shape
        const namespace = (getEnv() as unknown as Cloudflare.Env).REALTIME;

        const encoder = new TextEncoder();
        const { readable, writable } = new TransformStream<
          Uint8Array,
          Uint8Array
        >();
        const writer = writable.getWriter();
        const abort = new AbortController();

        let closed = false;
        // Writes are chained so frames from different channels can never
        // interleave mid-frame on the merged stream.
        let tail: Promise<unknown> = Promise.resolve();
        const send = (payload: unknown): void => {
          if (closed) return;
          tail = tail
            .then(() =>
              writer.write(
                encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
              )
            )
            .catch(() => close());
        };

        const ping = setInterval(
          () => send({ type: 'ping' }),
          PING_INTERVAL_MS
        );

        function close(): void {
          if (closed) return;
          closed = true;
          clearInterval(ping);
          abort.abort();
          void writer.close().catch(() => {});
        }

        request.signal.addEventListener('abort', close);

        const pump = async (channel: string): Promise<void> => {
          const stub = namespace.get(namespace.idFromName(channel));
          const response = await stub.fetch(
            new Request(
              `https://realtime.do/subscribe?channel=${encodeURIComponent(channel)}`,
              { signal: abort.signal }
            )
          );
          if (!response.body) return;

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
              const payload = parseFrame(buffer.slice(0, boundary));
              buffer = buffer.slice(boundary + 2);
              // Each DO emits its own connected/ping frames; the merged stream
              // publishes exactly one of each instead of N.
              if (payload && !isSystemEvent(payload)) send(payload);
              boundary = buffer.indexOf('\n\n');
            }
          }
        };

        // Deliberately not awaited: the response must reach the browser before
        // the sub-streams (which never end) are drained.
        void Promise.all(
          channels.map((channel) =>
            pump(channel).catch(() => {
              // One unreachable channel must not tear down the others.
            })
          )
        ).then(close, close);

        send({ type: 'connected', channels });

        return new Response(readable, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      },
    },
  },
});
