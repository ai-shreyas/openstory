import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the validation-path schema fetch (#458). This is the other half
 * of the create flow's trust boundary — `createGeneratedAsset` mocks it, so
 * these tests pin what that mock hides: URL construction for slash-bearing
 * endpoint ids, the 404 vs non-404 error split, the non-object-schema
 * rejection, and the optional Authorization header (via `getEnv`, which is
 * the read that actually works in workerd — not `process.env`).
 */
const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function fetchedHeaders(call: Parameters<typeof fetch>): Headers {
  const [input, init] = call;
  if (input instanceof Request) return input.headers;
  return new Headers(init?.headers);
}

let env: { MODELSCHEMAS_API_KEY?: string } = {};

async function importSchemaFetch() {
  vi.resetModules();
  vi.doMock('#env', () => ({ getEnv: () => env }));
  return import('./schema-fetch');
}

function schemaResponse(schema: object | string, status = 200): Response {
  return new Response(
    JSON.stringify({
      provider: 'fal',
      activity: 'image',
      endpointId: 'fal-ai/flux-1/dev',
      kind: 'input',
      contentHash: 'abc',
      schema,
    }),
    { status, headers: { 'content-type': 'application/json' } }
  );
}

const FLUX_SCHEMA = {
  type: 'object',
  properties: { prompt: { type: 'string' } },
  required: ['prompt'],
};

beforeEach(() => {
  mockFetch.mockReset();
  env = {};
});

describe('fetchModelInputSchema', () => {
  it('fetches the per-endpoint input schema, preserving id slashes in the path', async () => {
    mockFetch.mockResolvedValueOnce(schemaResponse(FLUX_SCHEMA));
    const { fetchModelInputSchema } = await importSchemaFetch();

    const schema = await fetchModelInputSchema('fal-ai/flux-1/dev', 'image');

    expect(schema).toEqual(FLUX_SCHEMA);
    const url = urlOf(mockFetch.mock.calls[0]?.[0] ?? '');
    expect(url).toBe(
      'https://modelschemas.com/v1/schemas/fal/image/fal-ai/flux-1/dev?kind=input'
    );
  });

  it('sends no Authorization header without a key, Bearer with one', async () => {
    // A fresh Response per call — a body can only be read once.
    mockFetch.mockImplementation(() =>
      Promise.resolve(schemaResponse(FLUX_SCHEMA))
    );

    const anonymous = await importSchemaFetch();
    await anonymous.fetchModelInputSchema('fal-ai/flux-1/dev', 'image');
    const anonymousCall = mockFetch.mock.calls[0];
    expect(
      anonymousCall && fetchedHeaders(anonymousCall).get('authorization')
    ).toBeNull();

    env = { MODELSCHEMAS_API_KEY: 'msk-123' };
    const keyed = await importSchemaFetch();
    await keyed.fetchModelInputSchema('fal-ai/flux-1/dev', 'image');
    const keyedCall = mockFetch.mock.calls[1];
    expect(keyedCall && fetchedHeaders(keyedCall).get('authorization')).toBe(
      'Bearer msk-123'
    );
  });

  it('maps a 404 to the unknown-endpoint message', async () => {
    mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const { fetchModelInputSchema } = await importSchemaFetch();

    await expect(fetchModelInputSchema('fal-ai/nope', 'video')).rejects.toThrow(
      "Unknown model endpoint 'fal-ai/nope' for activity 'video'"
    );
  });

  it('maps other non-OK statuses to a load-failure message with the status', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('rate limited', { status: 429 })
    );
    const { fetchModelInputSchema } = await importSchemaFetch();

    await expect(
      fetchModelInputSchema('fal-ai/flux-1/dev', 'image')
    ).rejects.toThrow(
      "Could not load the input schema for 'fal-ai/flux-1/dev' (429)"
    );
  });

  it('rejects a non-object schema body — an input we cannot validate must not run', async () => {
    mockFetch.mockResolvedValueOnce(schemaResponse('not-a-schema'));
    const { fetchModelInputSchema } = await importSchemaFetch();

    await expect(
      fetchModelInputSchema('fal-ai/flux-1/dev', 'image')
    ).rejects.toThrow(/non-object input schema/);
  });
});
