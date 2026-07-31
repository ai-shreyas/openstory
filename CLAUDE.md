# CLAUDE.md

AI-powered video sequence platform built with TanStack Start, deployed to Cloudflare Workers.

## Commands

```bash
# Dev
bun dev                            # App: env bootstrap, DB migrate + seed, Vite (Workerd via cf-plugin)
bun dev:all                        # bun dev + the Stripe listener (billing webhooks)
bun storybook                      # Storybook on :6006
bun explorer                       # Open the local CF Explorer (KV/R2/D1/DOs/Workflows)
bun db:studio:local                # Inspect local D1 tables (wrangler d1 execute)

# Quality
bun lint                           # oxlint (type-aware)
bun lint:fix
bun format                         # oxfmt
bun format:check
bun typecheck                      # tsgo --noEmit (NOT `tsc`)
bun dead-code                      # knip (unused exports)

# Tests
bun run test                       # unit (Vitest) — NOT `bun test` (that invokes Bun's built-in test runner)
bun run test src/path/foo.test.ts  # single file
bun run test:watch
bun run test:coverage
bun test:e2e                       # Playwright (vite dev cf-plugin webServer)
bun test:e2e:ui
bun test:e2e:setup                 # apply D1 migrations + seed for [env.test]
bun test:e2e:full                  # full-pipeline e2e (Cloudflare Workflows + aimock)
bun run build:e2e                  # built-server e2e build (VITE_APP_URL=:3001, devtools off)

# DB (Wrangler local D1 via Miniflare)
bun db:migrate:local               # drizzle-orm migrator against local D1 (default env)
bun db:migrate:test                # drizzle-orm migrator against local D1 ([env.test])
bun db:migrate:prd                 # flatten + wrangler d1 migrations apply DB --env=production --remote
bun db:seed:local                  # seed local D1 via getPlatformProxy
bun db:generate                    # generate migration from schema edits
bun db:studio:d1                   # Drizzle Studio against production D1

# Build / deploy
bun run build                      # Vite production build (NOT `bun build`)
bun cf:dev                         # wrangler dev against built worker (preview)
bun cf:deploy:prd                  # Manual production deploy (build → migrate → deploy)
bun run deploy                     # Deploy-button deploy command (migrate + deploy, default env)
bun deploy:production              # Workers Builds prod deploy command (migrate --env=production + deploy)
```

`bun dev` runs vite dev (cf-plugin → Workerd via Miniflare, port 3000). Its first step (`scripts/ensure-env.ts`) creates `.env.local` with generated secrets if missing, so a fresh clone needs only `bun install && bun dev`. Billing work uses `bun dev:all`, which additionally runs the Stripe listener (skipped without `STRIPE_SECRET_KEY`); it lives outside `bun dev` so a missing/uninstalled Stripe CLI never takes down the app server (e.g. in cloud preview sandboxes). The app runs in **Workerd locally** — same runtime as production — so D1, R2 bindings, **Cloudflare Workflows**, env.\* access, and request lifecycle all match prod. No QStash/Docker needed: workflows execute in-process in Workerd.

**Local Cloudflare services via the Explorer API.** While `bun dev` is running you have access to local Cloudflare services (KV, R2, D1, Durable Objects, and Workflows) for this app via the Explorer API at `http://localhost:3000/cdn-cgi/explorer/api`. Fetch that URL to get the OpenAPI schema and discover available operations, then use those endpoints to list, query, and manage local resources during development. `bun explorer` opens the Explorer UI in a browser.

**Bun-as-launcher pattern:** `bun script.ts` (no `--bun`) keeps Bun as the CLI launcher but executes under **Node**, while still autoloading `.env*`. Use `bun --env-file=<path>` to override the default `.env.local`. No `--bun` flag should appear in package.json scripts.

## Project Structure

```
src/
  routes/           # TanStack Router file-based routes
    api/            #   Webhooks (workflows + auth only)
    _app/           #   App shell (anonymous-browsable; actions gated behind login)
  functions/        # createServerFn endpoints — most business logic lives here
  components/       # React UI (shadcn/ui base + layout-only Tailwind)
  lib/
    ai/             #   AI model configs, prompt schemas, frame.schema
    db/             #   Drizzle schema + clients (D1 in prod + dev via Wrangler)
    services/       #   Frame, motion, etc. business services
    workflows/      #   Cloudflare Workflows durable definitions
    auth/           #   Better Auth wiring + action-utils
e2e/                # Playwright tests
scripts/            # CLI tooling and setup
drizzle/migrations/ # Generated SQL (do NOT hand-edit)
```

## Architecture

**Stack:** Bun (package manager + script launcher; Node is the runtime) · TanStack Start + Router + Vite (`@cloudflare/vite-plugin`) · Cloudflare D1 + Drizzle · Cloudflare Workflows (durable async) · Cloudflare R2 · Better Auth · Tailwind v4 + shadcn/ui · Vitest.

**Core rules:**

- Database access ONLY in server handlers (never in components).
- Anonymous-first → upgrade to save work.
- Team-based resources (sequences, styles, characters).
- Script-driven generation for consistency.

**Data model:**

```
teams
  ├── users (members)
  ├── sequences (videos)
  │   └── frames (scenes with metadata)
  └── libraries (styles, characters, vfx, audio)
```

## Setup

```bash
bun install
bun dev                            # That's it — env, migrations, seed all happen on first run
bun setup                          # Optional: add FAL_KEY / OPENROUTER_KEY interactively
bun setup --prod                   # Production config + deploy (--deploy, --pr-preview also available)
```

**Branch + commit conventions:** Branches must be named `<issue-number>-feature-name` (e.g. `393-improve-readme`). Lefthook extracts the issue number and tags commits with `#<issue>` automatically. See `CONTRIBUTING.md`. Lefthook also runs quality checks pre-commit.

---

## Server Handler Pattern

All API routes use TanStack Start server handlers. Standard shape:

```typescript
// src/routes/api/example/$id.ts
export const Route = createFileRoute('/api/example/$id')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      POST: async ({ params, request, context }) => {
        try {
          const input = schema.parse(await request.json());
          const { user, teamId } = context;

          const record = await db.insert(table).values({ ...input, teamId });

          // Trigger a durable workflow (see Workflow Pattern below)
          const workflowRunId = await triggerWorkflow('/image', {
            userId: user.id,
            teamId,
            ...input,
          });

          return json({ id: record.id, workflowRunId });
        } catch (error) {
          const handled = handleApiError(error);
          return json(
            { success: false, error: handled.toJSON() },
            { status: handled.statusCode }
          );
        }
      },
    },
  },
});
```

Steps: 1) validate input · 2) auth via `authWithTeamRequestMiddleware` (user/teamId on `context`) · 3) DB writes (only here) · 4) trigger workflow · 5) standardized response.

## Workflow Pattern

Durable async work runs on **Cloudflare Workflows**. Each workflow is a
`WorkflowEntrypoint` subclass; there is no QStash and no HTTP callback route.

**Triggering workflows — use `triggerWorkflow(path, body)`** from
`@/lib/workflow/client`. It resolves the workflow binding for `path` (see
`TRIGGER_TO_BINDING` in `src/lib/workflow/trigger-bindings.ts`) and calls
`binding.create()`, returning the workflow instance id (store it as
`workflowRunId`):

```typescript
const workflowRunId = await triggerWorkflow('/image', {
  userId,
  teamId,
  prompt,
  ...params,
});
```

Pass a stable `deduplicationId` in the options to make a trigger idempotent.

**Defining workflows** — each lives in `src/lib/workflows/<name>-workflow.ts`,
extends `OpenStoryWorkflowEntrypoint` (`src/lib/workflow/base-workflow.ts`),
and must be wired in three places (a test in
`src/lib/workflow/wiring-consistency.test.ts` enforces this):

1. `wrangler.jsonc` `workflows[]` — declares the binding + `class_name`.
2. `src/server.ts` — re-exports the class so it lands in the Worker bundle.
3. `TRIGGER_TO_BINDING` in `src/lib/workflow/trigger-bindings.ts` — maps the
   trigger path to the binding name.

The base class validates `userId`/`teamId` on the payload, builds a
`ScopedDb`, and sanitizes/handles failures. Subclasses implement
`runImpl(event, step, scopedDb)`, run steps via
`step.do('step-name', async () => { ... })` (durable, auto-retried), and write
DB updates directly. For parent→child fan-out (await a child's result), use
`spawnAndAwaitChild` from `src/lib/workflow/await-child.ts`.

## Frame System

Frames are the core content unit — each represents one scene from script analysis.

**Critical:** `frame.metadata` IS the `Scene` object (no wrapper). Fully typed via Drizzle JSONB.

```typescript
frame.metadata = {
  sceneId,
  sceneNumber,
  originalScript: { extract, lineNumber, dialogue },
  metadata: { title, durationSeconds, location, timeOfDay, storyBeat },
  variants: { cameraAngles, movementStyles, moodTreatments }, // A/B/C options
  selectedVariant: { cameraAngle, movementStyle, moodTreatment, rationale },
  prompts: {
    visual: { fullPrompt, negativePrompt, components, parameters },
    motion: { fullPrompt, components, parameters },
  },
  continuity: { characterTags, environmentTag, colorPalette, lightingSetup },
  musicDesign: { presence, style, mood, atmosphere },
};
```

Access via `frameService.getSceneData(frame)`, `getVisualPrompt(frame)`, `getMotionPrompt(frame)`, or directly: `frame.metadata.metadata.title`, `frame.metadata.prompts.visual.fullPrompt`. Storing the full scene lets us regenerate without re-analyzing the script and preserves variants for retries.

## Fal.ai Integration

**Always check `/llms.txt` before updating models.** Machine-readable, authoritative param specs:

```
https://fal.ai/models/{model-path}/llms.txt
# e.g. https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video/llms.txt
```

More reliable than HTML docs; essential for `src/lib/ai/models.ts`. **For new motion models, run `bun motion:codegen`** to auto-generate schemas — don't write inline.

Motion status checking: `checkMotionStatus(statusUrl)`, `getMotionResult(responseUrl)`, `cancelMotionGeneration(cancelUrl)` from `@/lib/services/motion.service`, or `bun scripts/check-motion-status.ts <url>`.

**Pricing is DB-backed (#1069).** `model_pricing` in D1 is the runtime source for estimation and billing; `src/lib/ai/fal-pricing-data.ts` is a **generated** seed the table layers over field-wise, so an empty table means "no overrides", not "no pricing". Never hand-edit the seed — `bun scripts/update-fal-pricing.ts` (needs `FAL_PRICING_KEY`). `bun dev` never fires `scheduled()`, so fill the table locally with `bun scripts/refresh-fal-pricing.ts` (needs `FAL_KEY`).

**Cron jobs need wiring in three places** (like Workflows): `wrangler.jsonc` `triggers.crons` in the **default** block, the same in **`[env.production]`** (non-inheritable), and the constant `scheduled()` string-matches on (e.g. `FAL_PRICING_CRON`). Drift is silent — an unmatched expression falls through to the 5-minute reconcile sweep, which _succeeds_, so the job just never runs. `src/lib/cron/refresh-fal-pricing.test.ts` enforces it.

---

## Server-side export (API)

Exporting a sequence to one stitched MP4 exists in **two** places:

- **Browser** (`src/lib/sequence-player/export.ts`, `use-sequence-export`) — the Theatre "Export MP4" button. Uses WebCodecs + Web Audio in the user's browser. **Unchanged.**
- **Server** (#968) — the public API. WebCodecs/Web Audio don't exist on Workers, so the heavy lift runs in a **Cloudflare Container** (`containers/video-export/`, Node + `@mediabunny/server`/NodeAV). Flow:
  - `POST /api/v1/sequences/$id/exports` reserves a `sequence_exports` row (`status: processing`) and triggers `SequenceExportWorkflow`; `GET …/exports` lists/polls them. (`src/routes/api/v1/sequences.$id.exports.ts`)
  - `SequenceExportWorkflow` (`src/lib/workflows/`) does **all** DB access via `scopedDb`, absolutizes scene/music URLs (`toShareableUrl`), POSTs the job to the container, streams the returned MP4 into R2 (`uploadFile`), and flips the row to `ready`/`failed`. The container is a **stateless renderer — it never touches D1**; it only gets URLs + params over HTTP.
  - `sequence_exports` gained `status`/`error`/`workflowRunId` (additive). `listBySequence`/`getLatest` are `ready`-only (the browser UI never sees in-flight/failed server rows); the API uses `listAllBySequence`.
- **v1 scope:** transmux-compatible (uniform AVC) sequences + music/dialogue mix. Mixed-resolution re-encode is rejected server-side (browser still handles it) — a follow-up.
- **Local dev:** `bun dev:all` runs the export service (`dev:bunny`, host bun runtime — no Docker, `node-av`/FFmpeg works under bun) AND sets `VIDEO_EXPORT_DEV_URL=http://localhost:8080` (via `CLOUDFLARE_INCLUDE_PROCESS_ENV`, the same injection Playwright uses) so the workflow POSTs to it instead of the (production-only) container binding — a full local export loop, zero config. Plain `bun dev` doesn't set the var (prod uses the container); for a two-terminal `bun dev` + `bun dev:bunny` setup, set `VIDEO_EXPORT_DEV_URL` in `.env.local` yourself. The container uses **bun** as its package manager (`bun.lock`, `trustedDependencies: ["node-av"]`) but **Node** as the image runtime. Container details, contract, and Docker build/smoke-test: `containers/video-export/README.md`.

---

## Database

**Schema management:**

```bash
bun db:generate  # Generate migrations from schema changes
bun db:migrate   # Apply migrations to local.db
```

- Schema in `src/lib/db/schema/` (Drizzle auto-infers types).
- **NEVER** hand-write migration SQL.
- **ULID** primary keys (not UUID).
- **Typed JSONB:** `frame.metadata` typed as `Scene`.

### wrangler.jsonc env layout — READ BEFORE TOUCHING

**Why the env split exists.** Remote bindings are **opt-in per binding** in current wrangler/`@cloudflare/vite-plugin` (`"remote": true`); local dev simulates everything in Miniflare by default. But the split is not just a remote-bindings guard — each block has its own job (see below), and historically the plugin DID default remote bindings on, which leaked Better Auth verification rows into `openstory-prd` D1 mid-#755. The placeholder-id strategy keeps that incident class impossible even if a plugin default flips again or someone runs a `--remote` command against the dev config.

**The structure.** `wrangler.jsonc` separates dev from prod via env blocks:

- **default** (no env) — triple duty: (1) `bun dev` / `vite dev` / `bun cf:dev` local simulation, (2) the patch base for PR-preview deploys (CI rewrites D1/bucket/workflow names in place), and (3) the provisioning template for Deploy-to-Cloudflare button deploys — its `database_name`/`bucket_name` are what a button user's fresh resources get called, and `tail_consumers` must stay `[]` so button deploys don't reference our log-forwarder Worker. The D1 binding has a **placeholder** `database_id: "dev-local-d1"` so any misrouted remote call (or buggy preview patch, or wrong-env deploy) 404s against Cloudflare rather than silently writing to prod. R2 buckets are **local Miniflare** too — stored media URLs are origin-relative (`/r2/<key>`, #894) and the worker's `/r2/$` route streams them from the binding when `R2_PUBLIC_STORAGE_DOMAIN` is unset (with a CDN domain set, the route redirects to it). Local dev needs no Cloudflare credentials. (Opt back into remote R2 by setting `"remote": true` on the binding + `R2_PUBLIC_STORAGE_DOMAIN` in `.env.local`; revert when done.)
- **`[env.production]`** — real prod D1 (`database_name: openstory-prd`, `database_id: d5981bee-...`; the `#897` cutover recreated it from the old `velro-prd`/`d6a35f64-...`, which is retired). Production builds MUST set `CLOUDFLARE_ENV=production` (so the built `dist/server/wrangler.json` bakes this block) and the migrate step MUST pass `--env=production` (wired in `deploy:production` / `cf:deploy:prd`). This block ALSO declares the **video-export Cloudflare Container** (#968): `containers[]` (built from `containers/video-export/Dockerfile`), the `VIDEO_EXPORT_CONTAINER` Durable Object binding, and migration tag `v2`. It is **production-only** so `bun dev` and e2e stay Docker-free — `wrangler deploy`/Workers Builds builds + pushes the image (Docker required only at deploy, which Workers Builds provides). See "Server-side export" below.
- **`[env.test]`** — Playwright e2e. Local Miniflare D1 (`database_id: "openstory-test-local"`) AND local Miniflare R2 — fully hermetic, no Cloudflare credentials in CI. Activated via `CLOUDFLARE_ENV=test` (set in `playwright.config.ts` envPrefix and CI workflow env block) for `vite dev`, or `wrangler dev --env=test` for the built-server path.

**Rules:**

- Never add `"remote": true` to a D1 binding. The placeholder-id strategy is the safety net.
- Production deploys run on **Workers Builds** (dashboard-connected to `main`, #900): build command `bun run build` with `CLOUDFLARE_ENV=production` as a build env var, deploy command `bun run deploy:production`. Manual fallback: `bun cf:deploy:prd`. Don't deploy a build made without `CLOUDFLARE_ENV=production` — it bakes the default block (placeholder D1) and fails loudly.
- PR-preview deploys patch the default block at runtime in `.github/workflows/deploy-cloudflare.yml` and deploy without `--env`. Each PR gets its own real D1 named `openstory-pr-<n>`.

**Local guardrail:** `bun dev` prints a wrangler-bindings banner on startup showing each binding's `local` / `REMOTE` status. If `DB` ever shows REMOTE, kill the server immediately and fix the config before any write lands in prod.

**Reproducing a prod bug locally:** temporarily set the default D1's `database_id` to the real prod value, restart `bun dev`, and revert when done. **Never commit a real prod D1 id into the default block.**

### D1 table-rebuild trap — READ BEFORE CHANGING SCHEMA

Remote migrations apply via `wrangler d1 migrations apply` (#897/#900: the `deploy` script for button deploys, `deploy:production` for upstream prod on Workers Builds, `db:migrate:prd` inside `cf:deploy:prd` for manual deploys), which sends each migration file as one multi-statement body. D1 wraps multi-statement bodies in an implicit transaction, and SQLite **silently** ignores `PRAGMA foreign_keys = OFF` inside a transaction. So when the standard SQLite "table rebuild" pattern (`CREATE __new_X` → `INSERT SELECT` → `DROP X` → `RENAME`) drops the parent table, every inbound `ON DELETE CASCADE` FK fires and child rows are deleted. (The original #612 incident hit the same trap through drizzle-kit's `d1-http` migrator, which no longer touches remote DBs — drizzle-kit only generates migrations now. Note drizzle-kit emits nested `<dir>/migration.sql` files; `scripts/flatten-migrations.ts` renders the flat gitignored `drizzle/migrations-wrangler/` dir that wrangler reads.)

This destroyed `team_members`, `session`, `account`, and `passkey` in production on 2026-04-29 (issue #612, migration `20260428013041_productive_kabuki`). `PRAGMA defer_foreign_keys = ON` does **not** help — it defers constraint _checks_ but CASCADE still fires.

**Workarounds (in order):**

1. **Avoid table rebuilds.** Prefer `ALTER TABLE … RENAME COLUMN / ADD COLUMN / DROP COLUMN` — SQLite/D1 support these without a rebuild.
2. **Apply destructive migrations manually.** Snapshot first (`wrangler d1 export`), then apply via the D1 dashboard or `wrangler d1 ... --file=…`. Do not let the automated `wrangler d1 migrations apply` paths run it (mark it applied in `d1_migrations` afterwards so they skip it).
3. **Avoid `ON DELETE CASCADE`** on FKs to long-lived parent tables (`user`, `teams`, `sequences`). Use `'restrict'` or `'no action'` and clean up children in app code.

**Local guardrail:** `scripts/check-migrations.ts` runs as a Lefthook pre-commit step on staged `drizzle/migrations/**/*.sql`. It flags `DROP TABLE`, `TRUNCATE`, `DELETE FROM`, `ALTER TABLE … DROP COLUMN`, and annotates each `DROP TABLE` with the count of inbound `ON DELETE CASCADE` FKs. Bypass for a manually-applied migration: `bun scripts/check-migrations.ts --allow-destructive`.

**Schema-drift trap (#898):** drizzle-kit only diffs **top-level exported** tables — removing a table's named export from `src/lib/db/schema/index.ts` (e.g. in a dead-code sweep) makes the next `db:generate` emit `DROP TABLE` for it. Keep every table individually exported. And never change a column's SQL `.default()` without generating the migration in the same PR — a default change forces a full table rebuild (see trap above); prefer `$defaultFn()` for app-level defaults with no DDL impact.

Refs: [drizzle-orm#3065](https://github.com/drizzle-team/drizzle-orm/issues/3065), [workers-sdk#5438](https://github.com/cloudflare/workers-sdk/issues/5438), [SQLite foreign_keys docs](https://sqlite.org/foreignkeys.html#fk_enable).

---

## React Patterns

**Quick reference** (rules; examples below for the contrarian ones):

- **Server data:** TanStack Query with `suspense: true`. No `isLoading` checks; use `<Suspense fallback={<Skeleton />} />`.
- **Styling:** shadcn/ui base components handle theming; Tailwind ONLY for layout (`flex`, `grid`, `gap`). No hard-coded colors. No `margin` on components — use flex+gap on the parent.
- **Loading:** inline `<Skeleton />` fallbacks that mirror final content (no separate skeleton components).
- **Visibility:** CSS `hidden`/`block` (pre-render) rather than conditional mounting, to avoid layout shift.
- **Forms:** TanStack Query mutations + Zod (`safeParse`) — no controlled-input boilerplate, use `FormData`.
- **Routing:** TanStack Router `createFileRoute`, params via `Route.useParams()`. URL reflects state via search params.
- **Files:** `kebab-case.tsx`, named exports, vanilla TS (`.ts`) for logic. `@/` alias. No default exports.

### Data fetching

```tsx
// ❌ useState + useEffect
const [user, setUser] = useState(null);
const [isLoading, setIsLoading] = useState(true);
useEffect(() => { fetch(...).then(r => r.json()).then(d => { setUser(d); setIsLoading(false); }); }, [userId]);
if (isLoading) return <div>Loading...</div>;

// ✅ TanStack Query + Suspense — no isLoading checks
const UserContent: React.FC<{ userId: string }> = ({ userId }) => {
  const { data: user } = useQuery({ queryKey: ['user', userId], queryFn: () => fetchUser(userId), suspense: true });
  return <div>{user.name}</div>;
};

export const UserProfile: React.FC<{ userId: string }> = (props) => (
  <Suspense fallback={<Skeleton className="h-6 w-32" />}><UserContent {...props} /></Suspense>
);
```

### Styling

```tsx
// ❌ Hard-coded colors, dark variants, margin on the component
<div className="w-[300px] m-4 p-6 bg-white dark:bg-slate-900 text-slate-900 dark:text-white rounded-xl shadow-lg border border-slate-200 dark:border-slate-700">
  <h3 className="text-xl font-bold mb-2">{frame.title}</h3>
</div>

// ✅ shadcn base handles theming; Tailwind for layout only; gap on parent (not margin on child)
<Card onClick={onSelect} className="cursor-pointer">
  <CardHeader><CardTitle>{frame.title}</CardTitle><CardDescription>{frame.description}</CardDescription></CardHeader>
</Card>

// Parent owns spacing:
<div className="grid grid-cols-3 gap-4">
  {frames.map(f => <FrameCard key={f.id} frame={f} />)}
</div>
```

### Forms

```tsx
// ❌ Controlled inputs everywhere, manual validation, setState per field

// ✅ Uncontrolled + FormData + Zod + TanStack Query mutation
export const ScriptForm: React.FC = () => {
  const mutation = useMutation({ mutationFn: createScript });

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const result = scriptSchema.safeParse(
      Object.fromEntries(new FormData(e.currentTarget))
    );
    if (!result.success) return; // surface errors inline
    mutation.mutate(result.data);
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Input name="title" placeholder="Script title…" required />
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Creating…' : 'Create'}
      </Button>
    </form>
  );
};
```

See `src/components/` for the house pattern.

## UI/UX Non-Negotiables

- Keyboard: full keyboard support per [WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/); visible `:focus-visible` rings.
- Inputs: hit targets ≥24px (mobile ≥44px), `font-size` ≥16px, never block paste, `autocomplete` + correct `type`/`inputmode`. Enter submits inputs; Ctrl/Cmd+Enter submits textareas.
- State: URL reflects filters/tabs/pagination; back/forward restores scroll. Use TanStack Router `<Link>` (supports Cmd/Ctrl/middle-click).
- Feedback: optimistic UI with rollback or Undo; confirm destructive actions; `aria-live="polite"` for toasts; ellipsis (`…`) for loading states.
- Animation: honor `prefers-reduced-motion`; animate `transform`/`opacity`; interruptible. CSS > WAAPI > JS libs.
- Accessibility: redundant cues (not color-only), `aria-label` for icon-only buttons, tabular numerics for comparisons, prefer native semantics.
- Performance: virtualize long lists (`virtua`); explicit image dimensions; mutations <500ms.

---

## Testing

**Unit-test framework:** Vitest (run via `bun run test`, never `bun test` — that invokes Bun's built-in runner and ignores `vitest.config.ts`).

- Server handlers: `__tests__/` alongside routes.
- Services/utils: co-located (`service.test.ts`).
- Focus: business logic, not React components.
- DB: mock `#db-client` via `vi.doMock` (not real connections); ULID primary keys.
- Workflows: mock workflow context + AI calls; pass auth (userId/teamId) through context.
- `vitest.config.ts` is **self-contained** — it does not extend `vite.config.ts`, because the Cloudflare Vite plugin rejects the SSR-externals shape Vitest injects.

**Module-mocking pattern** (preserves the runtime-ordered semantics bun:test's `mock.module` had — `vi.doMock` is NOT hoisted, so dynamic-import the target after mocking):

```typescript
import { describe, expect, it, vi } from 'vitest';
import * as realModule from '@/lib/some-module';

const mockFn = vi.fn();
vi.doMock('@/lib/some-module', () => ({ ...realModule, someExport: mockFn }));

// Dynamic import so the mock applies. Static imports are hoisted above
// vi.doMock and would bypass it. Prefer vi.mock + vi.hoisted for top-of-file
// mocks if you need static imports; vi.doMock + await import is the most
// direct port of the bun:test pattern.
const { thingUnderTest } = await import('./thing-under-test');
```

When re-mocking inside an `it()` block to test a different code path, call `vi.resetModules()` first — otherwise the dynamic import returns the cached module from the prior mock.

**E2E:** Playwright drives `vite dev` (cf-plugin → Workerd) on port 3001 with `E2E_TEST=true`. `bun test:e2e:setup` applies D1 migrations against the isolated `[env.test]` block in `wrangler.jsonc` and seeds via `getPlatformProxy()`. Aimock (`:4010`) intercepts LLM/fal calls. R2 is NOT mocked: uploads do real puts into the local Miniflare R2 binding (asset bytes come from the real `fal.media` URLs recorded in aimock fixtures) and reads are served by the worker's `/r2/$` route. Recording (`E2E_RECORD=1`) hits real LLM/fal; locally-served URLs sent to real providers are made fetchable via `fal.storage.upload` / data-URIs (`src/lib/storage/external-url.ts`).

## Platform & Deployment

Production target: **Cloudflare Workers** (the only supported platform). Deployment-context helpers (preview/local detection) live in `src/lib/utils/environment.ts`. Workers Builds auto-deploys main (same mechanism as Deploy-button clones); PRs get GitHub Actions preview deployments with unique D1 databases. See `.env.example` for required vars (or `bun setup` for local defaults).

<!-- intent-skills:start -->

# Skill mappings - load `use` with `bunx @tanstack/intent@latest load <use>`.

skills:

- when: "Use when writing test fixtures for @copilotkit/aimock — mock LLM responses, tool call sequences, error injection, multi-turn agent loops, embeddings, structured output, sequential responses, or debugging fixture mismatches"
  use: "@copilotkit/aimock#write-fixtures"
- when: "Entry point for TanStack AI skills. Routes to chat-experience, tool-calling, media-generation, structured-outputs, adapter-configuration, ag-ui-protocol, middleware, custom-backend-integration, and debug-logging. Use chat() not streamText(), openaiText() not createOpenAI(), toServerSentEventsResponse() not manual SSE, middleware hooks not onEnd callbacks."
  use: "@tanstack/ai#ai-core"
- when: "Provider adapter selection and configuration: openaiText, anthropicText, geminiText, ollamaText, grokText, groqText, openRouterText. Per-model type safety with modelOptions, reasoning/thinking configuration, runtime adapter switching, extendAdapter() for custom models, createModel(). API key env vars: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY/GEMINI_API_KEY, XAI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, OLLAMA_HOST."
  use: "@tanstack/ai#ai-core/adapter-configuration"
- when: "Server-side AG-UI streaming protocol implementation: StreamChunk event types (RUN_STARTED, TEXT_MESSAGE_START/CONTENT/END, TOOL_CALL_START/ARGS/END, RUN_FINISHED, RUN_ERROR, STEP_STARTED/STEP_FINISHED, STATE_SNAPSHOT/DELTA, CUSTOM), toServerSentEventsStream() for SSE format, toHttpStream() for NDJSON format. For backends serving AG-UI events without client packages."
  use: "@tanstack/ai#ai-core/ag-ui-protocol"
- when: "End-to-end chat implementation: server endpoint with chat() and toServerSentEventsResponse(), client-side useChat hook with fetchServerSentEvents(), message rendering with UIMessage parts, multimodal content, thinking/reasoning display. Covers streaming states, connection adapters, and message format conversions. NOT Vercel AI SDK — uses chat() not streamText()."
  use: "@tanstack/ai#ai-core/chat-experience"
- when: "Connect useChat to a non-TanStack-AI backend through custom connection adapters. ConnectConnectionAdapter (single async iterable) vs SubscribeConnectionAdapter (separate subscribe/send). Customize fetchServerSentEvents() and fetchHttpStream() with auth headers, custom URLs, and request options. Import from framework package, not @tanstack/ai-client."
  use: "@tanstack/ai#ai-core/custom-backend-integration"
- when: "Pluggable, category-toggleable debug logging for TanStack AI activities. Toggle with `debug: true | false | DebugConfig` on chat(), summarize(), generateImage(), generateSpeech(), generateTranscription(), generateVideo(). Categories: request, provider, output, middleware, tools, agentLoop, config, errors. Pipe into pino/winston/etc via `debug: { logger }`. Errors log by default even when `debug` is omitted; silence with `debug: false`."
  use: "@tanstack/ai#ai-core/debug-logging"
- when: "Image, audio, video, speech (TTS), and transcription generation using activity-specific adapters: generateImage() with openaiImage/geminiImage, generateAudio() with geminiAudio/falAudio, generateVideo() with async polling, generateSpeech() with openaiSpeech, generateTranscription() with openaiTranscription. React hooks: useGenerateImage, useGenerateAudio, useGenerateSpeech, useTranscription, useGenerateVideo. TanStack Start server function integration with toServerSentEventsResponse."
  use: "@tanstack/ai#ai-core/media-generation"
- when: "Chat lifecycle middleware hooks: onConfig, onStart, onChunk, onBeforeToolCall, onAfterToolCall, onUsage, onFinish, onAbort, onError. Use for analytics, event firing, tool caching (toolCacheMiddleware), logging, and tracing. Middleware array in chat() config, left-to-right execution order. NOT onEnd/onFinish callbacks on chat() — use middleware."
  use: "@tanstack/ai#ai-core/middleware"
- when: "Type-safe JSON schema responses from LLMs using outputSchema on chat(). Supports Zod, ArkType, and Valibot schemas. The adapter handles provider-specific strategies transparently — never configure structured output at the provider level. Pass stream:true alongside outputSchema for incremental JSON deltas + a terminal validated object via the `structured-output.complete` event. convertSchemaToJsonSchema() for manual schema conversion."
  use: "@tanstack/ai#ai-core/structured-outputs"
- when: "Isomorphic tool system: toolDefinition() with Zod schemas, .server() and .client() implementations, passing tools to both chat() on server and useChat/clientTools on client, tool approval flows with needsApproval and addToolApprovalResponse(), lazy tool discovery with lazy:true, rendering ToolCallPart and ToolResultPart in UI."
  use: "@tanstack/ai#ai-core/tool-calling"
- when: "Install TanStack Devtools, pick framework adapter (React/Vue/Solid/Preact), register plugins via plugins prop, configure shell (position, hotkeys, theme, hideUntilHover, requireUrlFlag, eventBusConfig). TanStackDevtools component, defaultOpen, localStorage persistence."
  use: "@tanstack/devtools#devtools-app-setup"
- when: "Publish plugin to npm and submit to TanStack Devtools Marketplace. PluginMetadata registry format, plugin-registry.ts, pluginImport (importName, type), requires (packageName, minVersion), framework tagging, multi-framework submissions, featured plugins."
  use: "@tanstack/devtools#devtools-marketplace"
- when: "Build devtools panel components that display emitted event data. Listen via EventClient.on(), handle theme (light/dark), use @tanstack/devtools-ui components. Plugin registration (name, render, id, defaultOpen), lifecycle (mount, activate, destroy), max 3 active plugins. Two paths: Solid.js core with devtools-ui for multi-framework support, or framework-specific panels."
  use: "@tanstack/devtools#devtools-plugin-panel"
- when: "Handle devtools in production vs development. removeDevtoolsOnBuild, devDependency vs regular dependency, conditional imports, NoOp plugin variants for tree-shaking, non-Vite production exclusion patterns."
  use: "@tanstack/devtools#devtools-production"
- when: "Two-way event patterns between devtools panel and application. App-to-devtools observation, devtools-to-app commands, time-travel debugging with snapshots and revert. structuredClone for snapshot safety, distinct event suffixes for observation vs commands, serializable payloads only."
  use: "@tanstack/devtools-event-client#devtools-bidirectional"
- when: "Create typed EventClient for a library. Define event maps with typed payloads, pluginId auto-prepend namespacing, emit()/on()/onAll()/onAllPluginEvents() API. Connection lifecycle (5 retries, 300ms), event queuing, enabled/disabled state, SSR fallbacks, singleton pattern. Unique pluginId requirement to avoid event collisions."
  use: "@tanstack/devtools-event-client#devtools-event-client"
- when: "Analyze library codebase for critical architecture and debugging points, add strategic event emissions. Identify middleware boundaries, state transitions, lifecycle hooks. Consolidate events (1 not 15), debounce high-frequency updates, DRY shared payload fields, guard emit() for production. Transparent server/client event bridging."
  use: "@tanstack/devtools-event-client#devtools-instrumentation"
- when: "Use devtools-utils factory functions to create per-framework plugin adapters. createReactPlugin/createSolidPlugin/createVuePlugin/createPreactPlugin, createReactPanel/createSolidPanel/createVuePanel/createPreactPanel. [Plugin, NoOpPlugin] tuple for tree-shaking. DevtoolsPanelProps (theme). Vue uses (name, component) not options object. Solid render must be function."
  use: "@tanstack/devtools-utils#devtools-framework-adapters"
- when: "Configure @tanstack/devtools-vite for source inspection (data-tsd-source, inspectHotkey, ignore patterns), console piping (client-to-server, server-to-client, levels), enhanced logging, server event bus (port, host, HTTPS), production stripping (removeDevtoolsOnBuild), editor integration (launch-editor, custom editor.open). Must be FIRST plugin in Vite config. Vite ^6 || ^7 only."
  use: "@tanstack/devtools-vite#devtools-vite-plugin"
- when: "Step-by-step migration from Next.js App Router to TanStack Start: route definition conversion, API mapping, server function conversion from Server Actions, middleware conversion, data fetching pattern changes."
  use: "@tanstack/react-start#lifecycle/migrate-from-nextjs"
- when: "React bindings for TanStack Start: createStart, StartClient, StartServer, React-specific imports, re-exports from @tanstack/react-router, full project setup with React, useServerFn hook."
  use: "@tanstack/react-start#react-start"
- when: "Implement, review, debug, and refactor TanStack Start React Server Components in React 19 apps. Use when tasks mention @tanstack/react-start/rsc, renderServerComponent, createCompositeComponent, CompositeComponent, renderToReadableStream, createFromReadableStream, createFromFetch, Composite Components, React Flight streams, loader or query owned RSC caching, router.invalidate, structuralSharing: false, selective SSR, stale names like renderRsc or .validator, or migration from Next App Router RSC patterns. Do not use for generic SSR or non-TanStack RSC frameworks except brief comparison."
  use: "@tanstack/react-start#react-start/server-components"
- when: "Framework-agnostic core concepts for TanStack Router: route trees, createRouter, createRoute, createRootRoute, createRootRouteWithContext, addChildren, Register type declaration, route matching, route sorting, file naming conventions. Entry point for all router skills."
  use: "@tanstack/router-core#router-core"
- when: "Route protection with beforeLoad, redirect()/throw redirect(), isRedirect helper, authenticated layout routes (\_authenticated), non-redirect auth (inline login), RBAC with roles and permissions, auth provider integration (Auth0, Clerk, Supabase), router context for auth state."
  use: "@tanstack/router-core#router-core/auth-and-guards"
- when: "Automatic code splitting (autoCodeSplitting), .lazy.tsx convention, createLazyFileRoute, createLazyRoute, lazyRouteComponent, getRouteApi for typed hooks in split files, codeSplitGroupings per-route override, splitBehavior programmatic config, critical vs non-critical properties."
  use: "@tanstack/router-core#router-core/code-splitting"
- when: "Route loader option, loaderDeps for cache keys, staleTime/gcTime/ defaultPreloadStaleTime SWR caching, pendingComponent/pendingMs/ pendingMinMs, errorComponent/onError/onCatch, beforeLoad, router context and createRootRouteWithContext DI pattern, router.invalidate, Await component, deferred data loading with unawaited promises."
  use: "@tanstack/router-core#router-core/data-loading"
- when: "Link component, useNavigate, Navigate component, router.navigate, ToOptions/NavigateOptions/LinkOptions, from/to relative navigation, activeOptions/activeProps, preloading (intent/viewport/render), preloadDelay, navigation blocking (useBlocker, Block), createLink, linkOptions helper, scroll restoration, MatchRoute."
  use: "@tanstack/router-core#router-core/navigation"
- when: "notFound() function, notFoundComponent, defaultNotFoundComponent, notFoundMode (fuzzy/root), errorComponent, CatchBoundary, CatchNotFound, isNotFound, NotFoundRoute (deprecated), route masking (mask option, createRouteMask, unmaskOnReload)."
  use: "@tanstack/router-core#router-core/not-found-and-errors"
- when: "Dynamic path segments ($paramName), splat routes ($ / \_splat), optional params ({-$paramName}), prefix/suffix patterns ({$param}.ext), useParams, params.parse/stringify, pathParamsAllowedCharacters, i18n locale patterns."
  use: "@tanstack/router-core#router-core/path-params"
- when: "validateSearch, search param validation with Zod/Valibot/ArkType adapters, fallback(), search middlewares (retainSearchParams, stripSearchParams), custom serialization (parseSearch, stringifySearch), search param inheritance, loaderDeps for cache keys, reading and writing search params."
  use: "@tanstack/router-core#router-core/search-params"
- when: "Non-streaming and streaming SSR, RouterClient/RouterServer, renderRouterToString/renderRouterToStream, createRequestHandler, defaultRenderHandler/defaultStreamHandler, HeadContent/Scripts components, head route option (meta/links/styles/scripts), ScriptOnce, automatic loader dehydration/hydration, memory history on server, data serialization, document head management."
  use: "@tanstack/router-core#router-core/ssr"
- when: "Full type inference philosophy (never cast, never annotate inferred values), Register module declaration, from narrowing on hooks and Link, strict:false for shared components, getRouteApi for code-split typed access, addChildren with object syntax for TS perf, LinkProps and ValidateLinkOptions type utilities, as const satisfies pattern."
  use: "@tanstack/router-core#router-core/type-safety"
- when: "TanStack Router bundler plugin for route generation and automatic code splitting. Supports Vite, Webpack, Rspack, and esbuild. Configures autoCodeSplitting, routesDirectory, target framework, and code split groupings."
  use: "@tanstack/router-plugin#router-plugin"
- when: "Core overview for TanStack Start: tanstackStart() Vite plugin, getRouter() factory, root route document shell (HeadContent, Scripts, Outlet), client/server entry points, routeTree.gen.ts, tsconfig configuration. Entry point for all Start skills."
  use: "@tanstack/start-client-core#start-core"
- when: "Server-side authentication primitives for TanStack Start: session cookies (HttpOnly, Secure, SameSite, \_\_Host- prefix), session read/issue/destroy via createServerFn and middleware, OAuth authorization-code flow with state and PKCE, password-reset enumeration defense, CSRF for non-GET RPCs, rate limiting auth endpoints, session rotation on privilege change. Pairs with router-core/auth-and-guards for the routing side."
  use: "@tanstack/start-client-core#start-core/auth-server-primitives"
- when: "Deploy to Cloudflare Workers, Netlify, Vercel, Node.js/Docker, Bun, Railway. Selective SSR (ssr option per route), SPA mode, static prerendering, ISR with Cache-Control headers, SEO and head management."
  use: "@tanstack/start-client-core#start-core/deployment"
- when: "Isomorphic-by-default principle, environment boundary functions (createServerFn, createServerOnlyFn, createClientOnlyFn, createIsomorphicFn), ClientOnly component, useHydrated hook, import protection, dead code elimination, environment variable safety (VITE\_ prefix, process.env)."
  use: "@tanstack/start-client-core#start-core/execution-model"
- when: "createMiddleware, request middleware (.server only), server function middleware (.client + .server), context passing via next({ context }), sendContext for client-server transfer, global middleware via createStart in src/start.ts, middleware factories, method order enforcement, fetch override precedence."
  use: "@tanstack/start-client-core#start-core/middleware"
- when: "createServerFn (GET/POST), inputValidator (Zod or function), useServerFn hook, server context utilities (getRequest, getRequestHeader, setResponseHeader, setResponseStatus), error handling (throw errors, redirect, notFound), streaming, FormData handling, file organization (.functions.ts, .server.ts)."
  use: "@tanstack/start-client-core#start-core/server-functions"
- when: "Server-side API endpoints using the server property on createFileRoute, HTTP method handlers (GET, POST, PUT, DELETE), createHandlers for per-handler middleware, handler context (request, params, context), request body parsing, response helpers, file naming for API routes."
  use: "@tanstack/start-client-core#start-core/server-routes"
- when: "Server-side runtime for TanStack Start: createStartHandler, request/response utilities (getRequest, setResponseHeader, setCookie, getCookie, useSession), three-phase request handling, AsyncLocalStorage context."
  use: "@tanstack/start-server-core#start-server-core"
- when: "Programmatic route tree building as an alternative to filesystem conventions: rootRoute, index, route, layout, physical, defineVirtualSubtreeConfig. Use with TanStack Router plugin's virtualRouteConfig option."
  use: "@tanstack/virtual-file-routes#virtual-file-routes"
- when: "Load environment variables from a .env file into process.env for Node.js applications. Use when configuring apps with secrets, setting up local development environments, managing API keys and database uRLs, parsing .env file contents, or populating environment variables programmatically. Always use this skill when the user mentions .env, even for simple tasks like \"set up dotenv\" — the skill contains critical gotchas (encrypted keys, variable expansion, command substitution) that prevent common production issues."
  use: "dotenv#dotenv"
- when: "Use dotenvx to run commands with environment variables, manage multiple .env files, expand variables, and encrypt env files for safe commits and CI/CD."
use: "dotenv#dotenvx"
<!-- intent-skills:end -->
