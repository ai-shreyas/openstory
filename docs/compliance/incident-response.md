# AIGC Incident Response Plan

How OpenStory traces AI-generated content back to its origin, and what we do
when content is reported. This is the operational plan; the capability map for
model-provider questionnaires is in [`README.md`](./README.md).

**Owner:** platform operator (currently the founder). **Review:** on each change
to the generation pipeline, and at least annually.

---

## 1. Scope

Applies to every asset the platform generates — still frames, video clips,
character/location/talent sheets, music, and stitched sequence exports — and to
every image a user uploads as a reference, including portraits of real people.

Three categories of incident:

| Category          | Examples                                                                           | Target first response              |
| ----------------- | ---------------------------------------------------------------------------------- | ---------------------------------- |
| **P0 — Critical** | CSAM; non-consensual intimate imagery; credible threat to life                     | Immediately, and no later than 24h |
| **P1 — Serious**  | Likeness/portrait misuse; impersonation of a real person; court or regulator order | 3 business days                    |
| **P2 — Standard** | Copyright/trademark; misleading content; other terms breaches                      | 10 business days                   |

`content_reports.priority` encodes this: `0` is forced for `csam` at intake
regardless of what the reporter selected, everything else enters at `50` and is
re-prioritised at triage.

---

## 2. Intake — how a report reaches us

1. **Public form**: `/report`. No account required, and no account is ever
   required — the person whose likeness was misused is precisely the person
   without a login here.
2. **Email**: the contact address published in the Terms.
3. **Provider or authority contact**: a model provider or a law-enforcement
   request arriving directly.

Every route lands in the same place: a `content_reports` row, visible in
**Admin → Moderation → Reports**, worst-priority-first then oldest-first.

Reports are acknowledged with a reference (`OS-<ulid>`) that the reporter can
quote on follow-up.

---

## 3. Trace — identifying the source of a generated asset

Use **Admin → Moderation → Trace content**. It accepts whatever the complainant
supplied:

- our own reference (`OS-01J…`),
- the asset URL or R2 object key,
- a SHA-256 of the file's bytes,
- the model provider's request id.

A match returns the `content_provenance` row: **team, user, provider, model,
provider request id, prompt hash, whether reference images were used and how
many, the workflow run id, and the timestamp.**

### What provenance deliberately does _not_ store

- **The prompt text.** Only its SHA-256. The text already lives in the versioned
  prompt tables; a second mutable copy would be a liability with no upside. The
  hash still proves which prompt produced the asset after the prompt is edited —
  the question that actually arises in a "we never asked for that" dispute.
- **A content hash — not yet, for any kind.** `contentSha256` exists and the
  trace console queries it, but nothing populates it today: assets stream from
  the provider straight into R2, and hashing would mean buffering the whole
  object (a 1080p clip can exceed the isolate's memory). Hashing the small kinds
  is the follow-up. Practical effect: you can trace by URL, R2 key, trace id, or
  provider request id, but **not** by the bytes of a file someone emails you with
  no filename.

### Coverage limits — read before relying on a trace

Provenance recording is instrumented at these points today:

- still images (`frame_variant`) — image workflow, including preview-mode runs
- video clips (`video_variant`) — motion workflow, and therefore motion batches
- direct model access (`generated_asset`) — one row per output file
- sequence exports (`sequence_export`) — the stitched MP4 that gets shared

**Not yet instrumented:** shot variants, upscales, character/location/talent
sheets, and music. These have `PROVENANCE_ASSET_KINDS` entries reserved and are
the follow-up; until then, trace them through the sequence graph directly
(`sequences` → `scenes` → `shots` → variant tables), which carries the same
team/user attribution. **Assets generated before this shipped have no provenance
row at all** and must be traced the same way.

Provenance writes are best-effort by design — an audit insert must never fail a
generation the user already paid for. A failure logs at `error` with the asset's
identity, so a gap is known rather than silent. Search logs for
`provenance record failed` to find them.

---

## 4. Act — enforcement

Record every decision in **Admin → Moderation**. Actions available, in
proportionality order:

| Action                 | Effect                                                                                           | Use for                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `warning`              | On the record; no restriction                                                                    | First minor breach                                  |
| `content_removed`      | On the record; no restriction                                                                    | Content violates terms, account acted in good faith |
| `generation_suspended` | No new generations; account can still sign in, read the notice, export existing work, and appeal | Most substantiated reports                          |
| `account_suspended`    | Read-only                                                                                        | Repeat or serious breach                            |
| `account_terminated`   | No access                                                                                        | CSAM, or repeated serious breach                    |

Effective state is always **derived** from `enforcement_actions`, never cached on
the user row — a stale flag drifts toward "we believed this account was
suspended and it was not". `revokedAt` lifts an action when an appeal succeeds
without erasing that it happened.

The gate that enforces this lives in `triggerWorkflow` — every generation in the
app funnels through it, so a new endpoint cannot forget the check. Exports are
gated on write access rather than generation access, so pausing generation over
one clip does not hold an account's unrelated finished work hostage.

### P0 additional steps

For CSAM, beyond removal and termination:

1. Preserve the evidence — do **not** delete the R2 objects or the provenance
   row; enforcement records use `ON DELETE RESTRICT` precisely so evidence
   survives.
2. Report to the relevant authority for the jurisdiction (in Australia, the
   eSafety Commissioner; NCMEC where a US nexus exists).
3. Notify the model provider whose model produced it, quoting their request id
   from the provenance row.
4. Review the account's full generation history
   (**Trace → team provenance**) for related material.

---

## 5. Notify

- **The reporter**: outcome, quoting their reference. Never disclose the subject
  account's identity.
- **The subject account**: the specific violation and how to appeal — our Terms
  promise this, and an enforcement action a user cannot see is
  indistinguishable from a broken product. `enforcement_actions.notifiedAt`
  records that it happened.
- **Never tell the subject who reported them.** That is how a rights complaint
  becomes harassment of the complainant.

---

## 6. Appeals

Appeals arrive through `/report` (the restriction notice links there) or by
email. A different reviewer than the one who applied the action should decide
where practical. A successful appeal is a **revocation**, not a deletion.

---

## 7. Preventive controls

| Control                                                           | Where                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| Terms prohibit likeness use without authorization                 | `/terms` § Acceptable Use                                      |
| Portrait-rights attestation required on likeness upload           | Add-talent dialog → `upload_attestations`                      |
| Real-name verification for likeness uploads and restricted models | `/settings/identity`, `IDENTITY_VERIFICATION_POLICY`           |
| Provider content filters, with rejections logged and queryable    | `src/lib/ai/content-rejection.ts`, PostHog `content_rejection` |
| Duplicate-identity detection across accounts                      | Salted name hash, surfaced at verification review              |

---

## 8. Records and retention

| Record                | Table                    | Retention                     |
| --------------------- | ------------------------ | ----------------------------- |
| Provenance            | `content_provenance`     | Life of the account + 2 years |
| Reports               | `content_reports`        | 5 years                       |
| Enforcement           | `enforcement_actions`    | 5 years                       |
| Attestations          | `upload_attestations`    | Life of the asset + 2 years   |
| Verification outcomes | `identity_verifications` | Life of the account + 2 years |

All five are append-only apart from narrow triage/status columns. Identity
documents are never stored — the verification provider is the system of record
for those, and we hold only the outcome and their reference.
