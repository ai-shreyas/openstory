/**
 * Compliance Schema — AIGC traceability, real-name verification, portrait-rights
 * attestation, abuse reports, and enforcement actions.
 *
 * These five tables are the record-keeping half of the platform-operator
 * obligations we take on by serving third-party generative models to external
 * users (BytePlus/ModelArk activation, #1180). Each maps to a specific
 * commitment — see `docs/compliance/README.md`:
 *
 *   content_provenance      → trace any circulating asset back to its origin
 *   identity_verifications  → real-name authentication for end users
 *   upload_attestations     → portrait-rights authorization evidence
 *   content_reports         → intake for violation reports
 *   enforcement_actions     → what we did about them
 *
 * Design constraints, all deliberate:
 *
 *  - **Append-only.** Nothing here is updated in place except a report's triage
 *    columns and a verification's status. Evidence you can rewrite is not
 *    evidence, and a regulator or arbitration panel asking "what did you know
 *    and when" needs rows that only ever grew.
 *  - **No raw identity PII.** `identity_verifications` stores the provider's
 *    reference and the OUTCOME, never a document number, scan, or date of
 *    birth. The provider is the system of record for the underlying identity
 *    data; we hold the proof that a check passed. Keeps a D1 breach from being
 *    an identity-document breach.
 *  - **`onDelete: 'restrict'` on every FK, never CASCADE.** `user` and `teams`
 *    are long-lived parent tables, and a D1 table rebuild fires inbound
 *    CASCADEs even with `PRAGMA foreign_keys = OFF` (the #612 incident — see
 *    the table-rebuild trap in CLAUDE.md). Compliance evidence is the last
 *    thing that should evaporate during a migration; `restrict` also means an
 *    account with open enforcement history cannot be quietly hard-deleted.
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
import { teams } from './teams';

// ============================================================================
// Content Provenance
// ============================================================================

/**
 * Asset kinds we record provenance for. Mirrors the storable-output surface:
 * every generated artifact that can leave the platform (download, share,
 * export, public gallery) must be traceable.
 */
const PROVENANCE_ASSET_KINDS = [
  'frame_variant',
  'video_variant',
  'shot_variant',
  'character_sheet',
  'location_sheet',
  'talent_sheet',
  'music_variant',
  'sequence_export',
  'generated_asset',
  'style_preview',
] as const;
export type ProvenanceAssetKind = (typeof PROVENANCE_ASSET_KINDS)[number];

/**
 * One generated artifact, recorded at the moment it lands in R2.
 *
 * This is the table an abuse report resolves against: given a URL, an R2 key,
 * or the bytes of a file someone sent us, find the team, the user, the model,
 * the prompt, and the time. The row's own `id` doubles as the public trace id
 * quoted in takedown correspondence — it is a ULID, so it leaks nothing beyond
 * a timestamp, and it can be handed to a complainant without exposing internal
 * sequence or user identifiers.
 *
 * Written from generation workflows via `WorkflowScopedDb.provenance.record()`.
 * The write lives in its own `step.do` so a transient D1 failure retries; a
 * failed insert after retries fails the run rather than leaving a silent gap.
 * `contentSha256` is not populated yet — look up by `storageKey` or
 * `providerRequestId`. Gaps surface as `provenance insert returned no id`
 * error logs.
 */
export const contentProvenance = snakeCase.table(
  'content_provenance',
  {
    /** ULID. Doubles as the public trace id (`OS-<id>`) in takedown replies. */
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),

    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    /**
     * The user who triggered the generation. Nullable ONLY for platform-owned
     * artifacts with no requesting user (system style previews seeded by a
     * script); user-triggered rows always carry it.
     */
    userId: text().references(() => user.id, { onDelete: 'restrict' }),

    assetKind: text({ length: 40 }).$type<ProvenanceAssetKind>().notNull(),
    /** PK of the row in the asset's own table (frame_variants.id, etc.). */
    assetId: text().notNull(),

    /**
     * R2 object key — the join key for "here is a file, who made it".
     * Origin-relative asset URLs (`/r2/<key>`, #894) are derived from this, so
     * the key is the stable identifier and the URL is not stored separately.
     */
    storageKey: text({ length: 500 }),
    /**
     * SHA-256 of the asset bytes, hex.
     *
     * **Nothing populates this yet** — it is the column the "here are loose
     * bytes with no filename, did you make this?" lookup needs, and the trace
     * console already queries it. Not populated because assets stream from the
     * provider straight into R2; hashing would mean buffering the whole object
     * (a 1080p clip can exceed the isolate's memory), so the follow-up is to
     * hash the small kinds only. Until then a null here is expected, and
     * `storageKey` plus `providerRequestId` carry the trace.
     */
    contentSha256: text({ length: 64 }),

    // ---- What produced it ----
    provider: text({ length: 50 }).notNull(),
    /** Provider endpoint / model id, e.g. `fal-ai/kling-video/v2.5-turbo/pro`. */
    model: text({ length: 200 }).notNull(),
    /**
     * The provider's own request id (fal `requestId`, ModelArk task id). The
     * bridge to the provider's logs: lets us answer a provider-side inquiry
     * ("which of your users made request X") without a scan.
     */
    providerRequestId: text({ length: 200 }),
    /** Cloudflare Workflows instance id that produced the asset. */
    workflowRunId: text({ length: 200 }),

    // ---- What it was asked to make ----
    /**
     * SHA-256 of the full resolved prompt, hex. Hashed rather than duplicated:
     * the prompt text already lives in the versioned prompt tables, and a
     * second mutable copy of user content is a liability with no upside. The
     * hash proves which prompt produced this asset even after the prompt is
     * edited — which is exactly the question in a "we never asked for that"
     * dispute.
     */
    promptSha256: text({ length: 64 }),
    /** Pointers into the sequence graph, when the asset came from one. */
    sequenceId: text(),
    shotId: text(),

    /**
     * Whether reference images were fed to the model, and how many. A portrait
     * complaint turns on this: text-to-video cannot infringe a likeness the
     * user supplied, image-to-video can. Kept as a count + flag rather than the
     * input list, which lives on the variant's manifest.
     */
    usedReferenceImages: integer({ mode: 'boolean' }).default(false).notNull(),
    referenceImageCount: integer().default(0).notNull(),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // "Here is a file / URL — who made it?" The two hot lookups.
    index('idx_provenance_storage_key').on(table.storageKey),
    index('idx_provenance_content_sha').on(table.contentSha256),
    // "Show me everything this account generated" — enforcement + audits.
    index('idx_provenance_team_created').on(table.teamId, table.createdAt),
    index('idx_provenance_user_created').on(table.userId, table.createdAt),
    // Provider-side inquiry by their request id.
    index('idx_provenance_provider_request').on(table.providerRequestId),
    // Backfill/dedupe: has this asset already been recorded?
    index('idx_provenance_asset').on(table.assetKind, table.assetId),
  ]
);

export type NewContentProvenance = InferInsertModel<typeof contentProvenance>;

// ============================================================================
// Identity Verification (real-name authentication)
// ============================================================================

/**
 * How an identity was checked. `byteplus_rpv` is BytePlus's own Real Person
 * Verification H5/API — the provider whose usage rules the ModelArk activation
 * binds us to, and the one to prefer for ModelArk-served models.
 * `manual_review` is a human check of documents supplied out-of-band (used for
 * enterprise accounts and for appeals); `dev_stub` only ever resolves outside
 * production and is rejected by the provider factory when deployed.
 */
const IDENTITY_VERIFICATION_PROVIDERS = [
  'byteplus_rpv',
  'manual_review',
  'dev_stub',
] as const;
export type IdentityVerificationProvider =
  (typeof IDENTITY_VERIFICATION_PROVIDERS)[number];

const IDENTITY_VERIFICATION_STATUSES = [
  'pending',
  'verified',
  'rejected',
  'expired',
  'revoked',
] as const;
export type IdentityVerificationStatus =
  (typeof IDENTITY_VERIFICATION_STATUSES)[number];

/**
 * What the check actually proved. `liveness` alone establishes a live human but
 * not a legal name; `document` alone establishes a name but not that the holder
 * is present. Real-name authentication in the sense platform rules mean it
 * wants `document_and_liveness`, which is what BytePlus RPV returns.
 */
export const IDENTITY_VERIFICATION_METHODS = [
  'document',
  'liveness',
  'document_and_liveness',
] as const;
export type IdentityVerificationMethod =
  (typeof IDENTITY_VERIFICATION_METHODS)[number];

/**
 * One identity check on one user. Append a new row per attempt; never rewrite
 * history. `status` is the only mutable column (pending → verified/rejected,
 * verified → expired/revoked), because the provider's answer arrives
 * asynchronously and a verification can later lapse.
 *
 * **Stores no identity documents and no raw identifiers.** The provider holds
 * those. We keep: which provider, their reference, what the check proved,
 * whether it passed, and when. `subjectNameSha256` lets us detect one legal
 * identity farming many accounts without our ever holding the name — the
 * abuse pattern behind most portrait-rights violations.
 */
export const identityVerifications = snakeCase.table(
  'identity_verifications',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** Team the user was acting for when they verified, for audit context. */
    teamId: text().references(() => teams.id, { onDelete: 'restrict' }),

    provider: text({ length: 40 })
      .$type<IdentityVerificationProvider>()
      .notNull(),
    /** The provider's verification id — our handle for a re-check or dispute. */
    providerRef: text({ length: 200 }),
    status: text({ length: 20 })
      .$type<IdentityVerificationStatus>()
      .default('pending')
      .notNull(),
    method: text({ length: 30 }).$type<IdentityVerificationMethod>(),

    /**
     * SHA-256 of the normalized verified legal name, salted with
     * `IDENTITY_HASH_SALT`. Not reversible to a name; equality-comparable, so
     * "how many accounts has this identity verified?" is answerable. Absent the
     * salt env var the field stays null and duplicate detection is simply off —
     * it never falls back to an unsalted hash, which would be a rainbow-table
     * target on a small name space.
     */
    subjectNameSha256: text({ length: 64 }),
    /** ISO 3166-1 alpha-2 of the issuing country, for jurisdiction routing. */
    subjectCountry: text({ length: 2 }),

    /** Provider-supplied failure code/message. Never contains document data. */
    rejectionReason: text({ length: 500 }),

    verifiedAt: integer({ mode: 'timestamp' }),
    /** Re-verification deadline, where the provider or a rule imposes one. */
    expiresAt: integer({ mode: 'timestamp' }),

    /** Set when an admin revokes a previously-good verification (fraud). */
    revokedAt: integer({ mode: 'timestamp' }),
    revokedByUserId: text().references(() => user.id, {
      onDelete: 'restrict',
    }),
    revokedReason: text({ length: 500 }),

    /** Request context at submission — evidence for a disputed verification. */
    ipAddress: text({ length: 45 }),
    userAgent: text({ length: 500 }),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // Hot path: "is this user verified right now?" on every gated action.
    index('idx_identity_verifications_user_status').on(
      table.userId,
      table.status
    ),
    // Provider callback resolves its own row by reference.
    index('idx_identity_verifications_provider_ref').on(table.providerRef),
    // Duplicate-identity sweep.
    index('idx_identity_verifications_subject_hash').on(
      table.subjectNameSha256
    ),
  ]
);

export type IdentityVerification = InferSelectModel<
  typeof identityVerifications
>;

// ============================================================================
// Upload Attestations (portrait rights)
// ============================================================================

/**
 * What kind of upload was attested to. Human-likeness surfaces
 * (`talent`, `talent_media`) carry the portrait-rights obligation; the others
 * carry the narrower IP warranty.
 */
export const ATTESTATION_SUBJECT_TYPES = [
  'talent',
  'talent_media',
  'sequence_element',
  'avatar_asset',
  'style_reference',
] as const;
export type AttestationSubjectType = (typeof ATTESTATION_SUBJECT_TYPES)[number];

/**
 * A user's on-the-record warranty that they hold the rights to something they
 * uploaded — portrait/likeness authorization for a real person, or IP rights
 * for a logo, product shot, or avatar asset.
 *
 * This is the row we produce when a rights-holder or a provider asks "on what
 * basis did you accept this image?". `statementSha256` pins the exact wording
 * shown, so an attestation made in 2026 cannot be misread against wording we
 * shipped later — the reason this is a hash of the rendered text and not just a
 * version label. Request context (IP, user agent) is captured because an
 * attestation whose author is deniable is not worth collecting.
 */
export const uploadAttestations = snakeCase.table(
  'upload_attestations',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),

    subjectType: text({ length: 40 }).$type<AttestationSubjectType>().notNull(),
    /** PK of the uploaded row (talent.id, talent_media.id, …). */
    subjectId: text().notNull(),

    /** Semver-ish label of the attestation text, e.g. `portrait-rights-v1`. */
    statementVersion: text({ length: 60 }).notNull(),
    /** SHA-256 of the exact statement text rendered to the user, hex. */
    statementSha256: text({ length: 64 }).notNull(),

    /**
     * True when the user declared the upload depicts a real, identifiable
     * person — the trigger for the portrait-authorization requirement and for
     * requiring a verified identity on the account.
     */
    depictsRealPerson: integer({ mode: 'boolean' }).default(false).notNull(),
    /**
     * Free-text basis the user gave for the authorization (release form
     * reference, "self", contract id). Not validated — its value is that a
     * false answer here is a documented misrepresentation, not a gap.
     */
    authorizationBasis: text({ length: 500 }),

    ipAddress: text({ length: 45 }),
    userAgent: text({ length: 500 }),

    attestedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // "Show me the attestation for this upload."
    index('idx_upload_attestations_subject').on(
      table.subjectType,
      table.subjectId
    ),
    // "Everything this account attested to" — enforcement + audit.
    index('idx_upload_attestations_user').on(table.userId, table.attestedAt),
    index('idx_upload_attestations_team').on(table.teamId, table.attestedAt),
  ]
);

export type UploadAttestation = InferSelectModel<typeof uploadAttestations>;

// ============================================================================
// Content Reports
// ============================================================================

/**
 * Why something was reported. Ordered loosely by escalation posture, and kept
 * deliberately coarse: a reporter picking from twelve overlapping options
 * mislabels, and the triage queue reads the free-text `details` anyway.
 * `csam` exists as its own category because it alone routes to immediate
 * takedown plus external referral rather than to normal triage.
 */
export const CONTENT_REPORT_REASONS = [
  'csam',
  'portrait_rights',
  'deepfake_impersonation',
  'copyright',
  'sexual_content',
  'violence_or_harm',
  'hate_or_harassment',
  'illegal_or_regulated',
  'misleading_content',
  'other',
] as const;
export type ContentReportReason = (typeof CONTENT_REPORT_REASONS)[number];

/** What the report points at. Mirrors `PROVENANCE_ASSET_KINDS` plus accounts. */
export const CONTENT_REPORT_TARGET_TYPES = [
  'sequence',
  'frame_variant',
  'video_variant',
  'music_variant',
  'sequence_export',
  'generated_asset',
  'talent',
  'sequence_element',
  'style',
  'user',
  'external_url',
] as const;
export type ContentReportTargetType =
  (typeof CONTENT_REPORT_TARGET_TYPES)[number];

export const CONTENT_REPORT_STATUSES = [
  'open',
  'triaged',
  'actioned',
  'dismissed',
] as const;
export type ContentReportStatus = (typeof CONTENT_REPORT_STATUSES)[number];

/**
 * An inbound complaint about generated content or an account.
 *
 * Reports are accepted from anyone, including anonymous non-users — a takedown
 * channel only reachable by signed-in customers is not a takedown channel, and
 * the person whose likeness was misused is precisely the person without an
 * account. Hence nullable `reporterUserId` plus an optional contact email.
 *
 * `traceId` accepts the `content_provenance.id` we quote in correspondence, so
 * a follow-up report resolves straight to the original asset without the
 * reporter needing a URL that may already be dead.
 */
export const contentReports = snakeCase.table(
  'content_reports',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),

    /** Null for anonymous/external reporters. */
    reporterUserId: text().references(() => user.id, { onDelete: 'restrict' }),
    reporterEmail: text({ length: 320 }),

    targetType: text({ length: 40 }).$type<ContentReportTargetType>().notNull(),
    /** PK of the reported row, or the URL for `external_url` reports. */
    targetId: text({ length: 1000 }).notNull(),
    /** `content_provenance.id`, when the reporter had a trace id. */
    traceId: text(),

    /**
     * Resolved owner of the reported content, denormalized at triage so the
     * queue can group by account without re-walking the graph, and so the row
     * still names the subject after the content itself is deleted.
     */
    subjectTeamId: text().references(() => teams.id, { onDelete: 'restrict' }),
    subjectUserId: text().references(() => user.id, { onDelete: 'restrict' }),

    reason: text({ length: 40 }).$type<ContentReportReason>().notNull(),
    details: text({ length: 5000 }),

    status: text({ length: 20 })
      .$type<ContentReportStatus>()
      .default('open')
      .notNull(),
    /**
     * Triage priority, 0 = highest. `csam` reports are forced to 0 on intake
     * regardless of what the reporter selected.
     */
    priority: integer().default(50).notNull(),

    /** Triage outcome — the only mutable columns on this table. */
    handledByUserId: text().references(() => user.id, {
      onDelete: 'restrict',
    }),
    handledAt: integer({ mode: 'timestamp' }),
    resolutionNotes: text({ length: 5000 }),

    /** Request context at intake — abuse-of-the-report-channel forensics. */
    ipAddress: text({ length: 45 }),
    userAgent: text({ length: 500 }),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // The triage queue: open reports, worst first, oldest first.
    index('idx_content_reports_status_priority').on(
      table.status,
      table.priority,
      table.createdAt
    ),
    // "What else has been reported about this account?"
    index('idx_content_reports_subject_team').on(table.subjectTeamId),
    index('idx_content_reports_subject_user').on(table.subjectUserId),
    // Duplicate detection on re-reports of the same asset.
    index('idx_content_reports_target').on(table.targetType, table.targetId),
    index('idx_content_reports_trace').on(table.traceId),
  ]
);

export type ContentReport = InferSelectModel<typeof contentReports>;

// ============================================================================
// Enforcement Actions
// ============================================================================

/**
 * What we did about a violation, ordered by severity.
 *
 * `generation_suspended` is separated from `account_suspended` on purpose: the
 * proportionate response to a portrait-rights complaint is to stop the account
 * generating while leaving it able to sign in, read the notice, export its
 * legitimate work, and appeal. An enforcement regime whose only lever is a
 * full ban gets used less than it should.
 */
export const ENFORCEMENT_ACTIONS = [
  'warning',
  'content_removed',
  'generation_suspended',
  'account_suspended',
  'account_terminated',
] as const;
export type EnforcementActionType = (typeof ENFORCEMENT_ACTIONS)[number];

/**
 * One enforcement decision against a user or team. Append-only except for
 * revocation, so an account's disciplinary history survives an appeal being
 * granted — `revokedAt` lifts the action's effect without erasing that it
 * happened.
 *
 * Effective state is always DERIVED from this table
 * (`resolveEnforcementState`), never denormalized onto `user` or `teams`. A
 * cached `suspended` flag drifts, and the direction it drifts is "we thought we
 * had banned them and had not".
 */
export const enforcementActions = snakeCase.table(
  'enforcement_actions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),

    /**
     * Subject of the action. At least one of user/team is always set; a user
     * action follows the person across teams, a team action covers every
     * member's shared workspace.
     */
    subjectUserId: text().references(() => user.id, { onDelete: 'restrict' }),
    subjectTeamId: text().references(() => teams.id, { onDelete: 'restrict' }),

    action: text({ length: 40 }).$type<EnforcementActionType>().notNull(),
    /** Category that justified it — mirrors `CONTENT_REPORT_REASONS`. */
    reason: text({ length: 40 }).$type<ContentReportReason>().notNull(),
    notes: text({ length: 5000 }),

    /** The report that triggered this, when there was one. */
    reportId: text().references(() => contentReports.id, {
      onDelete: 'restrict',
    }),

    /**
     * Admin who applied it. Nullable for reserved automated actions,
     * which would record `appliedBySystem` instead. Nothing sets that
     * column yet — CSAM only forces intake priority to 0.
     */
    actorUserId: text().references(() => user.id, { onDelete: 'restrict' }),
    appliedBySystem: text({ length: 100 }),

    effectiveAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    /** Null = indefinite, until revoked. Set for timed suspensions. */
    expiresAt: integer({ mode: 'timestamp' }),

    revokedAt: integer({ mode: 'timestamp' }),
    revokedByUserId: text().references(() => user.id, {
      onDelete: 'restrict',
    }),
    revokedReason: text({ length: 500 }),

    /**
     * Whether the subject was told. An enforcement action the user cannot see
     * is indistinguishable to them from a broken product, and "notify the user
     * of the specific violation" is what our own Terms promise.
     */
    notifiedAt: integer({ mode: 'timestamp' }),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // The gate: "does this user have an active action against them?"
    index('idx_enforcement_subject_user').on(
      table.subjectUserId,
      table.revokedAt
    ),
    index('idx_enforcement_subject_team').on(
      table.subjectTeamId,
      table.revokedAt
    ),
    // Admin history views.
    index('idx_enforcement_created').on(table.createdAt),
    index('idx_enforcement_report').on(table.reportId),
  ]
);

export type EnforcementAction = InferSelectModel<typeof enforcementActions>;
