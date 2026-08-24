import { DurableObject } from 'cloudflare:workers';

/**
 * Cloudflare-native realtime broker. One Durable Object instance per channel
 * (keyed by `idFromName(channel)`), replacing the previous Upstash
 * Realtime + Redis pub/sub layer (#802).
 *
 * Responsibilities:
 * - **Fan-out**: workers/workflows POST events to `/emit`; the DO broadcasts
 *   them to every connected SSE subscriber. Because a DO is a single addressable
 *   instance, all subscribers for a channel land on the same object, so an
 *   in-memory writer set is sufficient for cross-isolate fan-out (the emitter
 *   runs in a Workflow isolate, the subscriber in a request isolate).
 * - **Long-lived SSE**: the DO holds each `/subscribe` stream open itself, which
 *   fixes the reconnect loop the old request-isolate handler suffered (Workers
 *   don't hold an SSE stream open — see the kill-switch note that used to live
 *   in `providers.tsx`).
 * - **History replay**: events are persisted in the DO's own SQLite storage so a
 *   page refresh mid-generation can replay progress (`/history`). A periodic
 *   alarm prunes rows past the TTL / row cap.
 *
 * The wire format is intentionally simple and fully owned in-repo (see
 * `client.tsx`): each SSE `data:` line is a JSON object — a user event
 * `{ id, event, channel, data }` or a system event `{ type: 'connected' | 'ping' }`.
 */

/** Keep replayable history for 30 days (matches the old Redis stream expiry). */
const HISTORY_EXPIRE_SECS = 60 * 60 * 24 * 30;
/** Hard cap on stored rows per channel so a chatty channel can't grow without bound. */
const HISTORY_MAX_ROWS = 2000;
/** How often the prune alarm runs while a channel still has stored events. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** SSE keepalive cadence — keeps intermediaries from dropping an idle stream. */
const PING_INTERVAL_MS = 25_000;

type EmitBody = { event: string; data: unknown };

type HistoryRow = { seq: number; event: string; data: string; ts: number };

/** Shape returned by `/history` — `data` stays a JSON string for the caller to parse. */
export type ChannelHistoryMessage = {
  id: string;
  event: string;
  channel: string;
  data: string;
  /** Unix ms when the event was stored. Used to expire stale generating UI. */
  ts: number;
};

export class RealtimeChannel extends DurableObject {
  private readonly writers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private readonly encoder = new TextEncoder();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Idempotent + cheap; runs on each DO wake.
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        data TEXT NOT NULL,
        ts INTEGER NOT NULL
      )`
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const channel = url.searchParams.get('channel') ?? '';

    switch (url.pathname) {
      case '/emit':
        return this.handleEmit(request, channel);
      case '/history':
        return this.handleHistory(channel);
      case '/subscribe':
        return this.handleSubscribe(request, channel);
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async handleEmit(
    request: Request,
    channel: string
  ): Promise<Response> {
    const body = await request.json<EmitBody>();
    const ts = Date.now();
    const row = this.ctx.storage.sql
      .exec<{ seq: number }>(
        'INSERT INTO events (event, data, ts) VALUES (?, ?, ?) RETURNING seq',
        body.event,
        JSON.stringify(body.data),
        ts
      )
      .one();
    const id = String(row.seq);

    await this.ensurePruneAlarm();
    this.broadcast({ id, event: body.event, channel, data: body.data });

    return new Response(null, { status: 204 });
  }

  private handleHistory(channel: string): Response {
    const rows = this.ctx.storage.sql
      .exec<HistoryRow>(
        'SELECT seq, event, data, ts FROM events ORDER BY seq ASC'
      )
      .toArray();

    const messages: ChannelHistoryMessage[] = rows.map((r) => ({
      id: String(r.seq),
      event: r.event,
      channel,
      // `data` is already a JSON string in storage; pass it through verbatim so
      // the caller (getChannelHistoryFn) doesn't double-encode.
      data: r.data,
      ts: r.ts,
    }));

    return Response.json(messages);
  }

  private handleSubscribe(request: Request, channel: string): Response {
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    const writer = writable.getWriter();
    this.writers.add(writer);

    void writer
      .write(this.shot({ type: 'connected', channel }))
      .catch(() => this.dropWriter(writer));

    const ping = setInterval(() => {
      writer.write(this.shot({ type: 'ping' })).catch(() => {
        clearInterval(ping);
        this.dropWriter(writer);
      });
    }, PING_INTERVAL_MS);

    const cleanup = () => {
      clearInterval(ping);
      this.dropWriter(writer);
    };
    request.signal.addEventListener('abort', cleanup);

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  private broadcast(event: {
    id: string;
    event: string;
    channel: string;
    data: unknown;
  }): void {
    const shot = this.shot(event);
    for (const writer of this.writers) {
      writer.write(shot).catch(() => this.dropWriter(writer));
    }
  }

  private shot(payload: unknown): Uint8Array {
    return this.encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private dropWriter(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    if (!this.writers.delete(writer)) return;
    writer.close().catch(() => {});
  }

  private async ensurePruneAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    }
  }

  override async alarm(): Promise<void> {
    const cutoff = Date.now() - HISTORY_EXPIRE_SECS * 1000;
    this.ctx.storage.sql.exec('DELETE FROM events WHERE ts < ?', cutoff);
    this.ctx.storage.sql.exec(
      `DELETE FROM events WHERE seq NOT IN (
        SELECT seq FROM events ORDER BY seq DESC LIMIT ?
      )`,
      HISTORY_MAX_ROWS
    );

    const remaining = this.ctx.storage.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM events')
      .one().count;
    if (remaining > 0) {
      await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    }
  }
}
