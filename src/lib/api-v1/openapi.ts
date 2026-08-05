/**
 * OpenAPI 3.1 document for the public `/api/v1`, served at
 * `GET /api/v1/openapi.json`.
 *
 * The request body schema is generated from the SAME `apiCreateSequenceSchema`
 * the runtime validates against (via `z.toJSONSchema`), so the published
 * contract can't drift from what the endpoint actually accepts. Response
 * schemas are hand-authored to mirror the `SequenceState` / one-shot result
 * documents in `state.ts` / `create.ts`.
 *
 * Shot and music generation statuses reuse `SHOT_GENERATION_STATUSES` (their
 * value sets are identical); the sequence status set is declared locally.
 */

import { SHOT_GENERATION_STATUSES } from '@/lib/db/schema/shots';
import { apiEnhanceScriptSchema } from './enhance-input-schema';
import { API_V1_BASE } from './hal';
import { apiCreateSequenceSchema } from './input-schema';
import { z, type ZodType } from 'zod';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const GEN_STATUSES: JsonValue[] = [...SHOT_GENERATION_STATUSES];
const SEQUENCE_STATUSES: JsonValue[] = [
  'draft',
  'processing',
  'completed',
  'failed',
  'archived',
];

/** Recursively repoint Zod's `#/$defs/X` refs at OpenAPI `#/components/schemas/X`. */
function rewriteRefs(node: JsonValue): JsonValue {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === 'object') return rewriteRefsInObject(node);
  return node;
}

/** `rewriteRefs` specialised to a JSON object, preserving the JsonObject type. */
function rewriteRefsInObject(obj: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] =
      key === '$ref' && typeof value === 'string'
        ? value.replace('#/$defs/', '#/components/schemas/')
        : rewriteRefs(value);
  }
  return out;
}

/**
 * Split a generated request schema into an OpenAPI root component plus its lifted
 * `$defs` (CharacterRef, CreateCharacter, …), all refs repointed at
 * `#/components/schemas`. Zod emits a self-contained draft-2020-12 schema whose
 * internal `#/$defs` refs don't resolve once embedded in an OpenAPI document, so
 * we hoist them to siblings under `components.schemas`.
 */
function requestSchemas(schema: ZodType): {
  root: JsonObject;
  defs: JsonObject;
} {
  // Round-trip through JSON to get a plain, mutable JSON tree (no Zod classes).
  const generated: JsonObject = JSON.parse(
    JSON.stringify(z.toJSONSchema(schema))
  );
  const { $defs, $schema: _schema, ...root } = generated;
  const defs =
    $defs && typeof $defs === 'object' && !Array.isArray($defs) ? $defs : {};
  return {
    root: rewriteRefsInObject(root),
    defs: rewriteRefsInObject(defs),
  };
}

/** A representative create body, embedded as the request example. */
const EXAMPLE_CREATE_BODY: JsonObject = {
  script: 'A lighthouse keeper befriends a stranded whale.',
  title: 'Sea Tale',
  style: 'Cinematic Noir',
  targetSeconds: 30,
  motion: true,
  music: true,
  characters: ['Old Tom the keeper', { name: 'The whale', isHuman: false }],
  locations: ['Stormy lighthouse'],
};

/** A representative enhance body, embedded as the request example. */
const EXAMPLE_ENHANCE_BODY: JsonObject = {
  script: 'A lighthouse keeper befriends a stranded whale.',
  style: 'Cinematic Noir',
  targetSeconds: 30,
};

const statusEnum = (values: JsonValue[]): JsonObject => ({
  type: 'string',
  enum: values,
});
const nullableString: JsonObject = { type: ['string', 'null'] };
const genStatusObject: JsonObject = {
  type: 'object',
  required: ['status', 'url'],
  properties: { status: statusEnum(GEN_STATUSES), url: nullableString },
};
const countsObject: JsonObject = {
  type: 'object',
  required: ['shots', 'imagesReady', 'videosReady', 'videosFailed'],
  properties: {
    shots: { type: 'integer' },
    imagesReady: { type: 'integer' },
    videosReady: { type: 'integer' },
    videosFailed: {
      type: 'integer',
      description:
        'Shots whose video generation failed. Can be > 0 even when `status` is "completed".',
    },
  },
};
const posterObject: JsonObject = {
  type: ['object', 'null'],
  required: ['url'],
  properties: { url: { type: 'string' } },
};
const styleObject: JsonObject = {
  type: 'object',
  description:
    "The style the sequence was generated with — `id` is the UI's `styleId` filter value; `name` is what the UI search matches on (null only if the style row fails to resolve, which the FK normally makes impossible).",
  required: ['id', 'name'],
  properties: { id: { type: 'string' }, name: nullableString },
};
const modelsObject: JsonObject = {
  type: 'object',
  description:
    'The models the sequence was generated with — the raw ids the UI filters/sorts on.',
  required: ['analysis', 'image', 'video', 'music'],
  properties: {
    analysis: { type: 'string', description: 'Script-analysis model id.' },
    image: { type: 'string', description: 'Per-shot image model id.' },
    video: { type: 'string', description: 'Per-shot video model id.' },
    music: { ...nullableString, description: 'Music model id, if any.' },
  },
};

/** Shared error-envelope reference for 4xx/5xx responses. */
function errorResponse(description: string): JsonObject {
  return {
    description,
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/Error' } },
    },
  };
}

/** Build the full OpenAPI 3.1 document for `/api/v1`. */
export function buildOpenApiDocument(): JsonObject {
  const { root: createRequest, defs } = requestSchemas(apiCreateSequenceSchema);
  const { root: enhanceRequest, defs: enhanceDefs } = requestSchemas(
    apiEnhanceScriptSchema
  );

  const waitParam: JsonObject = {
    name: 'wait',
    in: 'query',
    required: false,
    description:
      'Long-poll duration: hold the request open until the resource changes or reaches a terminal state. Forms: "60s", "30" (seconds), "2m", "1500ms". Capped at 90s; absent/0/malformed returns immediately.',
    schema: { type: 'string' },
    example: '60s',
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'OpenStory API',
      version: 'v1',
      description:
        'Create AI video sequences from a script in one call. Generation is asynchronous: POST returns 202 with sequence id(s) and a status URL to poll (optionally with ?wait long-polling). Every response carries a HAL `_links` catalog of next actions.',
    },
    servers: [
      {
        url: '/',
        description: 'Relative to the origin serving this document.',
      },
    ],
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    tags: [
      { name: 'discovery', description: 'Unauthenticated self-description.' },
      { name: 'sequences', description: 'Create and watch video sequences.' },
      { name: 'scripts', description: 'Enhance scripts without generating.' },
    ],
    paths: {
      [API_V1_BASE]: {
        get: {
          tags: ['discovery'],
          summary: 'API root / instructions',
          description:
            'MCP-style self-description: an instructions narrative, the create request JSON Schema, and a HAL link catalog. Unauthenticated so discovery works before a key is wired up.',
          security: [],
          responses: {
            '200': {
              description: 'The API root document.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RootDocument' },
                },
              },
            },
          },
        },
      },
      [`${API_V1_BASE}/openapi.json`]: {
        get: {
          tags: ['discovery'],
          summary: 'This OpenAPI 3.1 document',
          security: [],
          responses: {
            '200': {
              description: 'The OpenAPI document.',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      [`${API_V1_BASE}/sequences`]: {
        get: {
          tags: ['sequences'],
          summary: "List this team's sequences",
          description:
            "List the API key team's sequences, most recent first (by updatedAt). Each entry is a compact summary — status-document scalars plus a `counts` block, without the per-shot array — and carries a HAL `self` link to its full status document. Archived sequences are excluded. Page with ?limit (default 20, max 100) and the opaque ?cursor returned in the response's `next` link.",
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              description: 'Max sequences to return (1–100). Default 20.',
              schema: { type: 'integer', minimum: 1, maximum: 100 },
              example: 20,
            },
            {
              name: 'cursor',
              in: 'query',
              required: false,
              description:
                "Opaque pagination cursor. Echo back the value from the response's `next` link to fetch the following page.",
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description:
                'A page of sequence summaries with a HAL `_links` catalog (`self`, `create-sequence`, and `next` when more remain).',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SequenceListResult' },
                },
              },
            },
            '400': errorResponse('Invalid limit or cursor.'),
            '401': errorResponse('Missing or invalid API key.'),
            '403': errorResponse('No team associated with the key.'),
            '429': errorResponse('Per-key rate limit exceeded (10 req/s).'),
          },
        },
        post: {
          tags: ['sequences'],
          summary: 'Create a video sequence (one-shot)',
          description:
            'Validate input, optionally enhance the script, resolve style/cast/locations/elements, then trigger async generation. Responds 202 with the created sequence id(s), workflow run id(s), a status URL, and a HAL `_links` catalog. With ?wait, blocks until each new sequence shows first progress (or a terminal state) and embeds that snapshot.',
          parameters: [waitParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateSequenceRequest' },
                example: EXAMPLE_CREATE_BODY,
              },
            },
          },
          responses: {
            '202': {
              description:
                'Sequence(s) created; generation is async. Without ?wait the entries are summaries; with ?wait each entry embeds a `state` snapshot plus `waitChanged`/`waitDone`.',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/CreateSequenceResult' },
                      { $ref: '#/components/schemas/CreateSequenceWaitResult' },
                    ],
                  },
                },
              },
            },
            '400': errorResponse('Invalid JSON or request body.'),
            '401': errorResponse('Missing or invalid API key.'),
            '403': errorResponse('No team associated with the key.'),
            '429': errorResponse('Per-key rate limit exceeded (10 req/s).'),
          },
        },
      },
      [`${API_V1_BASE}/scripts/enhance`]: {
        post: {
          tags: ['scripts'],
          summary: 'Enhance a script (streaming)',
          description:
            'Enhance/expand a script WITHOUT creating a sequence, using the enhancement-relevant inputs (style, aspect ratio, target duration, elements). Streams the result as Server-Sent Events: unnamed `data:` shots each carry `{ "delta": "..." }`; a terminal `event: done` shot carries the full `{ "enhancedScript": "...", "_links": {...} }` — a HAL catalog whose `create-sequence` affordance embeds a ready-to-POST example body using the enhanced script. A failure after streaming starts arrives as an `event: error` shot `{ code, message }`. Pre-stream failures (invalid body, unresolvable style, billing) return the JSON error envelope instead.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EnhanceScriptRequest' },
                example: EXAMPLE_ENHANCE_BODY,
              },
            },
          },
          responses: {
            '200': {
              description:
                'An SSE stream of the enhanced script. Delta shots, then a terminal `done` shot with the full text and a HAL `_links` catalog of next actions.',
              content: {
                'text/event-stream': {
                  schema: { type: 'string' },
                  example:
                    'data: {"delta":"INT. "}\n\ndata: {"delta":"LIGHTHOUSE"}\n\nevent: done\ndata: {"enhancedScript":"INT. LIGHTHOUSE - NIGHT\\n...","_links":{"create-sequence":{"href":"/api/v1/sequences","method":"POST"}}}\n\n',
                },
              },
            },
            '400': errorResponse('Invalid JSON or request body.'),
            '401': errorResponse('Missing or invalid API key.'),
            '403': errorResponse('No team associated with the key.'),
            '404': errorResponse('No style found matching the reference.'),
            '429': errorResponse('Per-key rate limit exceeded (10 req/s).'),
          },
        },
      },
      [`${API_V1_BASE}/sequences/{id}`]: {
        get: {
          tags: ['sequences'],
          summary: 'Get sequence status',
          description:
            'DB-derived status document: overall status, per-shot image/video status + URLs, music, poster, and ready/failed counts, plus a HAL `_links` catalog. With ?wait, long-polls until the sequence changes or reaches a terminal state.',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'The sequence id (ULID).',
              schema: { type: 'string' },
            },
            waitParam,
          ],
          responses: {
            '200': {
              description: 'The sequence status document.',
              headers: {
                'X-Wait-Changed': {
                  description:
                    'Only present when ?wait was set. "true" if the sequence advanced during the wait, "false" if the wait timed out unchanged.',
                  schema: { type: 'string', enum: ['true', 'false'] },
                },
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SequenceState' },
                },
              },
            },
            '401': errorResponse('Missing or invalid API key.'),
            '403': errorResponse('No team associated with the key.'),
            '404': errorResponse('No such sequence for this key.'),
            '429': errorResponse('Per-key rate limit exceeded (10 req/s).'),
          },
        },
      },
      [`${API_V1_BASE}/sequences/{id}/exports`]: {
        get: {
          tags: ['sequences'],
          summary: 'List server-side exports',
          description:
            "Lists this sequence's server-side MP4 exports in any status (processing/ready/failed), newest first. Poll until an entry is `ready`, then download its `url`.",
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'The sequence id (ULID).',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'The list of exports.',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/SequenceExportsResult',
                  },
                },
              },
            },
            '401': errorResponse('Missing or invalid API key.'),
            '404': errorResponse('No such sequence for this key.'),
          },
        },
        post: {
          tags: ['sequences'],
          summary: 'Start a server-side MP4 export',
          description:
            "Stitches the sequence's scene videos and mixes music + dialogue into one MP4, rendered in a Cloudflare Container (mediabunny) and stored in R2. Async: responds 202 with a `processing` export — poll the GET endpoint until it is `ready`. An already in-flight export is reused rather than duplicated. Takes no body.",
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'The sequence id (ULID).',
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description: 'No parameters; send `{}` or an empty body.',
                },
              },
            },
          },
          responses: {
            '202': {
              description: 'Export accepted (newly started or coalesced).',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/SequenceExportAccepted',
                  },
                },
              },
            },
            '401': errorResponse('Missing or invalid API key.'),
            '404': errorResponse('No such sequence for this key.'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Send the API key as "Authorization: Bearer <key>".',
        },
        apiKeyHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'Send the API key as "x-api-key: <key>".',
        },
      },
      schemas: {
        CreateSequenceRequest: createRequest,
        ...defs,
        EnhanceScriptRequest: enhanceRequest,
        ...enhanceDefs,
        HalLink: {
          type: 'object',
          required: ['href'],
          description:
            'One callable affordance. Absent `method` means GET, per HAL convention.',
          properties: {
            href: { type: 'string' },
            method: statusEnum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
            title: { type: 'string' },
            templated: { type: 'boolean' },
            contentType: { type: 'string' },
            examples: { type: 'array', items: {} },
            stepUp: { type: 'boolean' },
            idempotencyRequired: { type: 'boolean' },
          },
        },
        HalLinks: {
          type: 'object',
          description: 'A catalog of affordances keyed by relation name.',
          additionalProperties: { $ref: '#/components/schemas/HalLink' },
        },
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
        SequenceStateShot: {
          type: 'object',
          required: ['id', 'orderIndex', 'title', 'image', 'video'],
          properties: {
            id: { type: 'string' },
            orderIndex: { type: 'integer' },
            title: nullableString,
            image: genStatusObject,
            video: genStatusObject,
          },
        },
        SequenceState: {
          type: 'object',
          required: [
            'id',
            'title',
            'status',
            'statusError',
            'aspectRatio',
            'style',
            'models',
            'createdAt',
            'updatedAt',
            'poster',
            'music',
            'shots',
            'counts',
            '_links',
          ],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            status: statusEnum(SEQUENCE_STATUSES),
            statusError: nullableString,
            aspectRatio: { type: 'string' },
            style: styleObject,
            models: modelsObject,
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            poster: posterObject,
            music: genStatusObject,
            shots: {
              type: 'array',
              items: { $ref: '#/components/schemas/SequenceStateShot' },
            },
            counts: countsObject,
            _links: { $ref: '#/components/schemas/HalLinks' },
          },
        },
        SequenceListItem: {
          type: 'object',
          description:
            'A compact sequence summary (status-document scalars + style, models, and counts, without the shot array) as returned in a list page.',
          required: [
            'id',
            'title',
            'status',
            'statusError',
            'aspectRatio',
            'style',
            'models',
            'createdAt',
            'updatedAt',
            'poster',
            'music',
            'counts',
            '_links',
          ],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            status: statusEnum(SEQUENCE_STATUSES),
            statusError: nullableString,
            aspectRatio: { type: 'string' },
            style: styleObject,
            models: modelsObject,
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            poster: posterObject,
            music: genStatusObject,
            counts: countsObject,
            _links: { $ref: '#/components/schemas/HalLinks' },
          },
        },
        SequenceListResult: {
          type: 'object',
          description:
            'A page of sequence summaries, most recent first. `_links.next` is present only when a further page exists.',
          required: ['sequences', '_links'],
          properties: {
            sequences: {
              type: 'array',
              items: { $ref: '#/components/schemas/SequenceListItem' },
            },
            _links: { $ref: '#/components/schemas/HalLinks' },
          },
        },
        SequenceSummary: {
          type: 'object',
          description: 'A created sequence (non-?wait response entry).',
          required: ['id', 'status', 'workflowRunId', 'statusUrl', '_links'],
          properties: {
            id: { type: 'string' },
            status: statusEnum(SEQUENCE_STATUSES),
            workflowRunId: { type: 'string' },
            statusUrl: { type: 'string' },
            _links: { $ref: '#/components/schemas/HalLinks' },
          },
        },
        WaitedSequence: {
          type: 'object',
          description:
            'A created sequence with its first progress snapshot embedded (?wait response entry).',
          required: ['id', 'workflowRunId', 'state', 'waitChanged', 'waitDone'],
          properties: {
            id: { type: 'string' },
            workflowRunId: { type: 'string' },
            state: {
              oneOf: [
                { $ref: '#/components/schemas/SequenceState' },
                { type: 'null' },
              ],
            },
            waitChanged: {
              type: 'boolean',
              description: 'The sequence advanced during the wait.',
            },
            waitDone: {
              type: 'boolean',
              description: 'The sequence reached a terminal state.',
            },
          },
        },
        CreateSequenceResult: {
          type: 'object',
          required: ['sequences', '_links'],
          properties: {
            sequences: {
              type: 'array',
              items: { $ref: '#/components/schemas/SequenceSummary' },
            },
            enhancedScript: {
              type: 'string',
              description: 'Present only when script enhancement ran.',
            },
            _links: { $ref: '#/components/schemas/HalLinks' },
          },
        },
        CreateSequenceWaitResult: {
          type: 'object',
          required: ['sequences', '_links'],
          properties: {
            sequences: {
              type: 'array',
              items: { $ref: '#/components/schemas/WaitedSequence' },
            },
            enhancedScript: { type: 'string' },
            _links: { $ref: '#/components/schemas/HalLinks' },
          },
        },
        SequenceExport: {
          type: 'object',
          description: 'One server-side MP4 export of a sequence.',
          required: [
            'id',
            'status',
            'url',
            'durationSeconds',
            'error',
            'createdAt',
          ],
          properties: {
            id: { type: 'string' },
            status: statusEnum(['processing', 'ready', 'failed']),
            url: {
              oneOf: [{ type: 'string' }, { type: 'null' }],
              description:
                'Absolute download URL, present only when `status` is `ready`.',
            },
            durationSeconds: {
              oneOf: [{ type: 'number' }, { type: 'null' }],
            },
            error: {
              oneOf: [{ type: 'string' }, { type: 'null' }],
              description:
                'Failure reason, present only when `status` is `failed`.',
            },
            createdAt: { type: 'string', format: 'date-time' },
            workflowRunId: { type: 'string' },
          },
        },
        SequenceExportsResult: {
          type: 'object',
          required: ['sequenceId', 'exports', '_links'],
          properties: {
            sequenceId: { type: 'string' },
            exports: {
              type: 'array',
              items: { $ref: '#/components/schemas/SequenceExport' },
            },
            _links: { $ref: '#/components/schemas/HalLinks' },
          },
        },
        SequenceExportAccepted: {
          type: 'object',
          required: ['export', '_links'],
          properties: {
            export: { $ref: '#/components/schemas/SequenceExport' },
            _links: { $ref: '#/components/schemas/HalLinks' },
          },
        },
        RootDocument: {
          type: 'object',
          required: [
            'name',
            'version',
            'instructions',
            'requestSchema',
            '_links',
          ],
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
            instructions: { type: 'string' },
            requestSchema: {
              type: 'object',
              additionalProperties: true,
              description: 'The create request body as JSON Schema.',
            },
            _links: { $ref: '#/components/schemas/HalLinks' },
          },
        },
      },
    },
  };
}
