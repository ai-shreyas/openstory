/**
 * Rewrite Grok quality/edit aimock match.userMessage bodies so Image-N
 * legends match slice-derived tags (#1218). Responses stay as recorded.
 *
 *   bun scripts/patch-e2e-fal-edit-matchers.ts
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reconstructRecordedFalEditPrompts } from '@/lib/ai/recorded-e2e-fal-prompts';

const FAL_DIR = resolve(
  import.meta.dirname,
  '../e2e/fixtures/recorded/fal/xai-grok-imagine-image-quality-edit'
);

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const files = readdirSync(FAL_DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => {
    const path = resolve(FAL_DIR, name);
    const raw = readFileSync(path, 'utf8');
    const data: {
      fixtures: Array<{ match: { userMessage: string } }>;
    } = JSON.parse(raw);
    const userMessage = data.fixtures[0]?.match.userMessage;
    if (!userMessage) throw new Error(`No userMessage in ${name}`);
    return { name, path, raw, userMessage };
  });

let patched = 0;
for (const live of reconstructRecordedFalEditPrompts()) {
  if (files.some((file) => file.userMessage === live.prompt)) continue;
  const closest = files
    .map((file) => ({
      file,
      prefix: commonPrefixLength(file.userMessage, live.prompt),
    }))
    .sort((a, b) => b.prefix - a.prefix)[0];
  if (!closest) throw new Error(`No fal fixture for scene ${live.sceneNumber}`);
  const oldEncoded = JSON.stringify(closest.file.userMessage);
  if (!closest.file.raw.includes(oldEncoded)) {
    throw new Error(
      `Could not locate encoded userMessage in ${closest.file.path}`
    );
  }
  writeFileSync(
    closest.file.path,
    closest.file.raw.replace(oldEncoded, JSON.stringify(live.prompt))
  );
  closest.file.userMessage = live.prompt;
  closest.file.raw = readFileSync(closest.file.path, 'utf8');
  patched++;
  console.log(
    `patched scene ${live.sceneNumber} ${live.kind} → ${closest.file.name} (prefix ${closest.prefix})`
  );
}
console.log(`patched ${patched} fal quality/edit matchers`);
