-- #1101 — file the legacy preview renders under the kind they always were.
--
-- A preview is a render of the RAW SCENE TEXT, not of the frame's prompt: it
-- exists so something can appear during script analysis, BEFORE a prompt
-- version does. That is a third variant axis, not a model's take on the
-- prompt, so it becomes `kind = 'preview'`.
--
-- WHAT IS RECLASSIFIED — deliberately narrow. A row moves only when all hold:
--   * kind = 'model'             — 'framing' rows are 3x3 grid sheets / tile
--                                  picks and were never previews.
--   * model = 'flux_2_turbo'     — PREVIEW_IMAGE_MODEL. The model is NOT what
--                                  makes a preview a preview going forward
--                                  (the workflow now writes the kind
--                                  directly), but for these historical rows it
--                                  is the only surviving discriminator: they
--                                  predate the kind and the model is hidden,
--                                  so no user could ever have picked it.
--   * prompt_version_id IS NULL  — corroborates the above. A preview is not a
--                                  render of any prompt version; production
--                                  has 0 of these rows carrying one. A
--                                  flux_2_turbo row that somehow DID name a
--                                  prompt version is a real still and stays.
--   * url IS NULL AND storage_path IS NULL — the load-bearing guard. The model
--                                  name alone is NOT safe: #989 step 3
--                                  (20260626074439_amused_chamber) synthesised
--                                  primary rows from `shots.image_model`, which
--                                  pre-#989 preview runs left at flux_2_turbo,
--                                  paired with a genuine `thumbnail_url`. Those
--                                  rows are real stills wearing the preview
--                                  model's name, and today only the
--                                  not-selected clause below hides them — which
--                                  lapses the moment a user picks another
--                                  model's version. Misfiling one is
--                                  IRREVERSIBLE: `select` then refuses it
--                                  (frame-variants.ts), it drops out of image
--                                  history, and the prior kind is overwritten.
--                                  Every genuine husk is url-less and
--                                  path-less, because the legacy preview path
--                                  opened a 'generating' row, skipped the R2
--                                  upload, and never completed it (`onFailure`
--                                  early-returns on skipStorage, so it never
--                                  went 'failed' either). Skipping the upload
--                                  IS the definition of a preview, so this is a
--                                  code-derived signature rather than a
--                                  coincidence about a model name.
--   * no frame points at it, by EITHER pointer — belt and braces. A row a frame
--                                  selects is that frame's still by definition,
--                                  and `frameVariants.select` refuses a preview
--                                  from here on, so reclassifying a selected
--                                  row would strand the pointer. Production has
--                                  0 selected flux_2_turbo rows.
--                                  `pending_promote_version_id` is joined too:
--                                  `selectIfPendingPromoteIs` clears the claim
--                                  BEFORE calling the now-throwing `select`, so
--                                  a reclassified claim target would discard
--                                  its claim and then fail. Unreachable today
--                                  (previews use skipStorage, which returns
--                                  before the claim is ever set), but the join
--                                  costs one line and makes that independent of
--                                  a reachability argument a future change to
--                                  the model picker could invalidate. Note it
--                                  is NOT covered by the url guard above: an
--                                  in-flight claim row is url-less too.
--
-- Once these are 'preview', `listModelsForSequence` (kind = 'model' only)
-- stops returning flux_2_turbo, which is what lets `getSequenceImageModelsFn`
-- drop its `hidden`-model filter — that filter was a workaround for this
-- misclassification, and it would have broken the moment a second fast model
-- shipped or flux_2_turbo was unhidden.
--
-- NOT backfilled: `frames.preview_image_url`. A preview is a raw fal CDN url
-- that expires within hours; the column's live values are the stand-in for
-- sequences mid-analysis, and one that survives to the deploy is either
-- already superseded by its real still or already dead. Minting rows from it
-- would import broken images, not preserve data. The next analysis run writes
-- a real 'preview' row.
--
-- Set-based, not correlated subqueries — those trip D1's remote CPU limit, and
-- migrations apply BEFORE deploy, so a slow one freezes the deploy (#1019).
-- Idempotent: re-running matches 0 rows. Touches no schema, so there is no
-- table rebuild and the #612 cascade trap does not apply.

UPDATE `frame_variants`
SET `kind` = 'preview'
FROM (
  SELECT fv.`id` AS `version_id`
  FROM `frame_variants` fv
  LEFT JOIN `frames` f ON f.`selected_image_version_id` = fv.`id`
  LEFT JOIN `frames` fp ON fp.`pending_promote_version_id` = fv.`id`
  WHERE fv.`kind` = 'model'
    AND fv.`model` = 'flux_2_turbo'
    AND fv.`prompt_version_id` IS NULL
    AND fv.`url` IS NULL
    AND fv.`storage_path` IS NULL
    AND f.`id` IS NULL
    AND fp.`id` IS NULL
) m
WHERE `frame_variants`.`id` = m.`version_id`;
