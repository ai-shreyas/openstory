---
title: Cloudflare Workflows PoC — Phase A
description: First slice of the migration sketched in the feasibility doc — full infrastructure plus a single leaf workflow (image) ported to Cloudflare Workflows behind a per-workflow engine switch.
section: Investigations
order: 2
---

# Cloudflare Workflows PoC — Phase A

**Status:** Phase A landed. QStash is still the default engine for every workflow; `image` can be canaried to Cloudflare Workflows via env var.

**Issue:** #728 ("cloudflare workflows" — investigate + PoC).

---

## What this PoC delivers

This is **Phase A** of the rollout sketched in §8 of the feasibility doc: a leaf workflow ported end-to-end so the infrastructure is proven before deeper porting begins. Concretely:

1. **Full infrastructure** for running CF Workflows alongside QStash.
   - `OpenStoryWorkflowEntrypoint` base class with sanitized failure handler (Gap D).
   - `spawnAndAwaitChild` / `notifyParent` helpers for Pattern 3 sub-workflow await (Gap A).
   - Environment-namespaced instance IDs (Gap F) — PR previews and production cannot see each other's instances.
   - Per-workflow engine registry + `CF_WORKFLOWS_ENABLED` canary env var.
2. **One leaf workflow ported:** `image-workflow`. Mirrors the QStash version step-for-step. Snapshot pattern, failure parity, divergence detection, and frame writes all behave identically.
3. **Trigger switch.** `triggerWorkflow()` consults the registry; CF branch uses the binding, QStash branch is unchanged.
4. **Wrangler binding + class export** so `wrangler dev` and production deploys both see the entrypoint.

What this PoC **does not** deliver (deferred to follow-up issues — see §6):

- The storyboard / analyze-script orchestrator port (the deepest sub-workflow tree).
- Pattern 3 exercised under real fan-out (`frame-images` × N scenes).
- `scene-split` streaming inside `step.do` (Gap C).
- D1-backed payload store for >1 MiB step results (Gap B).
- Removal of the QStash route / package.

These all build on the infrastructure landed here; deferring them keeps this PR reviewable and lets us measure leaf-level wins on production before committing to the deeper port.

---

## Files added

```text
src/lib/workflow/cf/
  ├── base-workflow.ts          OpenStoryWorkflowEntrypoint + failure wrapper
  ├── await-child.ts            Pattern 3 helpers (spawnAndAwaitChild, notifyParent)
  ├── engine-registry.ts        per-workflow engine selector + CF_WORKFLOWS_ENABLED
  ├── instance-id.ts            env-namespaced instance ID generation
  ├── trigger-bindings.ts       trigger-path → binding map + resolveEngineForTrigger
  ├── types.ts                  CloudflareEnv + WorkflowEngine
  ├── instance-id.test.ts
  └── engine-registry.test.ts

src/lib/workflows/cf/
  └── image-workflow.ts         ImageWorkflow entrypoint (mirrors QStash version)

docs/investigations/
  └── cloudflare-workflows-poc.md  (this file)
```

## Files changed

- `src/lib/workflow/client.ts` — `triggerWorkflow()` checks the registry; new CF branch.
- `src/server.ts` — re-exports `ImageWorkflow` so the bundler includes it.
- `wrangler.jsonc` — `workflows[]` entry binding `IMAGE_WORKFLOW` → `ImageWorkflow`.

---

## How the switch works

```text
caller (server fn) ──► triggerWorkflow('/image', body)
                              │
                              ▼
                   resolveEngineForTrigger
                              │
                ┌─────────────┴─────────────┐
        engine='qstash'              engine='cloudflare'
                │                            │
                ▼                            ▼
       WorkflowClient.trigger        binding.create({ id, params })
       (existing path)               (new CF path)
```

Default: every workflow → `'qstash'`. Override per workflow via either:

1. **Map entry** in `WORKFLOW_ENGINES` (`src/lib/workflow/cf/engine-registry.ts`) — durable flip, lands in code review.
2. **Env var** `CF_WORKFLOWS_ENABLED=image[,motion,...]` — canary without redeploy.

If a workflow is flagged `'cloudflare'` but its binding isn't in `wrangler.jsonc` (or the typegen hasn't run), `triggerWorkflow` logs loudly and falls back to QStash so the system stays available.

---

## How the failure parity works

QStash workflows set a `failureFunction` that emits `generation.failed` and writes a failed status to the relevant DB row. CF Workflows has no equivalent — failures just mark the instance `errored`. The `OpenStoryWorkflowEntrypoint` base class fills the gap:

```typescript
export abstract class OpenStoryWorkflowEntrypoint<T> extends WorkflowEntrypoint<
  CloudflareEnv,
  T
> {
  protected abstract runImpl(event, step, scopedDb): Promise<unknown>;
  protected onFailure?(failure): Promise<void>;

  override async run(event, step) {
    try {
      return await this.runImpl(event, step, scopedDb);
    } catch (error) {
      const sanitized = sanitizeFailResponse(error);
      if (this.onFailure) {
        await step.do('emit-failure', () =>
          this.onFailure({ event, error: sanitized, scopedDb })
        );
      }
      throw error;
    }
  }
}
```

The cleanup runs in its own `step.do` so it benefits from CF's per-step retries, and we swallow cleanup errors so they can't mask the original throw.

---

## How sub-workflow await works (Pattern 3)

Not exercised yet — `image` is a leaf — but the helpers ship in this PR so the next porting PR can use them straight away.

```typescript
// In a parent workflow:
const result = await spawnAndAwaitChild(step, {
  binding: this.env.IMAGE_WORKFLOW,
  parentBindingName: 'STORYBOARD_WORKFLOW',
  parentInstanceId: event.instanceId,
  childId: `image:${sequenceId}:${frameId}`,
  childPayload: {
    /* ...image input */
  },
  spawnStepName: 'spawn-image-7',
  awaitStepName: 'await-image-7',
  timeout: '30 minutes',
});

// In the child workflow's last step:
await notifyParent(step, this.env, event.payload._parent, output);
```

The helper injects a `_parent` slot into the child's payload carrying the parent's binding name + instance ID + a unique event type. The child's final step (or the base class's failure wrapper) calls `parent.sendEvent(...)` with the typed outcome. The parent's `step.waitForEvent` returns the same outcome.

Per-spawn unique event types (`${qualifier}-done:${childId}`) mean N siblings in a fan-out cannot match each other's events.

---

## How instance-ID namespacing works (Gap F)

The killer footgun in CF Workflows is that instance IDs are global per Worker script. A PR-preview deploy and production deploy of the same Worker share the same `IMAGE_WORKFLOW` binding namespace; calling `binding.create({ id: 'image:seq-123:frame-7' })` from a preview would collide with a real production run.

`buildInstanceId({ env, workflowName, suffix })` prepends `${envSlug}:${workflowName}:` where `envSlug` is derived from `VITE_APP_URL`:

| Environment      | `VITE_APP_URL`                 | `envSlug`              |
| ---------------- | ------------------------------ | ---------------------- |
| Production       | `https://openstory.so`         | `openstory-so`         |
| PR-preview       | `https://pr-123.openstory.dev` | `pr-123-openstory-dev` |
| Local (wrangler) | _unset_                        | `local`                |

The slug is the **only** mechanism preventing cross-env contamination. All CF instance ID generation must go through `buildInstanceId`. Direct calls to `binding.create({ id: '...' })` without the helper are not safe — code review should catch them.

---

## How to canary `image` to Cloudflare Workflows

1. Deploy this PR. Nothing changes — `image` still routes to QStash because `WORKFLOW_ENGINES` has no entry for it and `CF_WORKFLOWS_ENABLED` is unset.
2. In Cloudflare dashboard or via `wrangler secret put`, set `CF_WORKFLOWS_ENABLED=image` on the deployment you want to test (start with a PR preview).
3. Trigger any image generation. `triggerWorkflow('/image', ...)` should log `[TriggerWorkflow] CF Response:` instead of the QStash response.
4. Watch the CF dashboard's Workflows panel for the new instance. Confirm the steps match the QStash version's checkpoints.
5. Force a failure (e.g. submit an invalid prompt) and confirm `generation.image:progress` fires with `status: 'failed'` and `frames.thumbnailStatus = 'failed'` in D1.

To roll back: unset the env var. The next trigger goes to QStash again. No state migration is needed because the two engines never write each other's state.

---

## Local development

The PoC is designed not to disturb the existing `bun dev` flow:

- Workers-runtime-only imports (`cloudflare:workers`) only execute when the binding is present. In `bun dev` (Vite + Node), `env.IMAGE_WORKFLOW` is `undefined`, the engine selector falls back to QStash, and the existing Docker QStash path runs as before.
- To exercise the CF path locally, use `bun cf:dev` (which runs `wrangler dev`). Wrangler 4.79+ runs an emulated Workflows engine in-process, so no Docker is needed. Set `CF_WORKFLOWS_ENABLED=image` in `.dev.vars` first.

---

## What still needs validating against the success criteria in §7 of the feasibility doc

Phase A by itself can't answer the orchestrator-shaped questions. It can answer the leaf-shaped ones:

| Criterion (from feasibility §7)             | Answerable from Phase A?    | Notes                                                                                         |
| ------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| End-to-end wall time on a 9-scene script    | No — need orchestrator port | Defer to Phase C.                                                                             |
| Realtime events fire identically            | **Yes** for `image`         | Compare the `generation.image:progress` stream before/after canarying.                        |
| Mid-flight `terminate()` cleans up children | No — need fan-out           | Defer to Phase B.                                                                             |
| PR-preview isolation works                  | **Yes**                     | `buildInstanceId` tests prove the mechanism; integration test in §validation below.           |
| `bun dev` runs without Docker               | No                          | Still uses QStash for everything else. Becomes true only when the last QStash workflow ports. |
| Output payloads stay under 1 MiB            | **Yes** for `image`         | Image workflow output is `{ imageUrl, frameId, sequenceId }` — trivially small.               |
| No step exceeds 5-min CPU cap               | **Yes** for `image`         | Longest step is `generate-image` (Fal HTTP call) — well under the cap.                        |
| Failure-function parity                     | **Yes**                     | Forced-failure smoke test, see §validation below.                                             |
| `wrangler dev` emulator parity              | Partial                     | Only validates `step.do` + base-class retries; sleep / waitForEvent / parallel deferred.      |

---

## Validation steps for this PR

Run before merging. None of these require a deploy.

```bash
# 1. Unit tests for the new helpers.
bun test src/lib/workflow/cf

# 2. Typecheck the whole tree (the new CF imports must compile against the
#    existing cloudflare-env.d.ts and the QStash version of image-workflow
#    must still typecheck).
bun typecheck

# 3. The QStash path must be unchanged. Spot-check by triggering any image
#    generation from `bun dev`; logs should NOT include `[TriggerWorkflow] CF Response`.
bun dev
```

Local CF smoke test (optional, requires wrangler):

```bash
# 4. Generate types for the new binding.
bun cf:typegen

# 5. Build + run under wrangler. Set CF_WORKFLOWS_ENABLED=image in .dev.vars first.
bun preview

# 6. Trigger an image generation from the UI. Confirm:
#    - `[TriggerWorkflow] CF Response:` appears in wrangler logs
#    - `wrangler workflows list image-workflow --local` shows the instance
#    - The frame ends up with a thumbnail in D1
```

Forced-failure smoke test:

```bash
# 7. Same as above but submit an empty prompt. Expected:
#    - The workflow errors during `set-generating-status`
#    - `step.do('emit-failure')` runs and writes thumbnailStatus='failed'
#    - `generation.image:progress` fires with status='failed'
#    - The CF dashboard shows the instance in `errored` state
```

---

## Follow-up issues to file after this lands

1. **Phase B — fan-out leaf:** port `frame-images-workflow` (parent of `image`). Validates `spawnAndAwaitChild` under real fan-out (N children) and the unique-event-type assumption at N=20+ scenes.
2. **Phase B — operational leaves:** port `motion-workflow` (validates `step.sleep` polling loop wins) and `music-workflow` (validates short HTTP-bound step).
3. **Payload overflow store:** add D1 table + helper for `>1 MiB` step results so child-output overflow has a documented mitigation in place before Phase C.
4. **Phase C — orchestrators:** port `analyze-script-workflow` + `storyboard-workflow`. The big one — depends on Phase B's measurements.
5. **Gap C — streaming `scene-split`:** evaluate whether wrapping the LLM stream in a single `step.do` is acceptable, or whether the per-chunk DB writes need a Durable Object.
6. **Phase E — retire QStash:** once every workflow is on CF, delete `serveMany` route + QStash packages + Docker step from `bun dev`.

Each follow-up should reference this doc and the original feasibility doc for context.
