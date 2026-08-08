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
--   * it is not selected by any frame — belt and braces. A row a frame points
--                                  at is that frame's still by definition, and
--                                  `frameVariants.select` refuses a preview
--                                  from here on, so reclassifying a selected
--                                  row would strand the pointer. Production
--                                  has 0 selected flux_2_turbo rows.
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
  WHERE fv.`kind` = 'model'
    AND fv.`model` = 'flux_2_turbo'
    AND fv.`prompt_version_id` IS NULL
    AND f.`id` IS NULL
) m
WHERE `frame_variants`.`id` = m.`version_id`;
