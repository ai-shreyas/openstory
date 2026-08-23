/**
 * Decide whether a cast character can keep the talent's existing sheet
 * instead of generating a new costumed one.
 *
 * Default is reuse. We only regenerate when the script's costume or
 * distinguishing features are clearly not already on the talent sheet.
 */

export type ReuseTalentSheetInput = {
  characterClothing?: string | null;
  characterFeatures?: string | null;
  characterPhysical?: string | null;
  talentClothing?: string | null;
  talentFeatures?: string | null;
  talentPhysical?: string | null;
  talentDescription?: string | null;
};

const STOPWORDS = new Set([
  'the',
  'and',
  'or',
  'with',
  'without',
  'wearing',
  'wears',
  'wear',
  'dressed',
  'over',
  'under',
  'from',
  'into',
  'onto',
  'this',
  'that',
  'their',
  'them',
  'they',
  'her',
  'his',
  'she',
  'him',
  'has',
  'have',
  'for',
  'are',
  'was',
  'were',
]);

const GENERIC_CLOTHING = new Set([
  'casual',
  'streetwear',
  'everyday',
  'normal',
  'regular',
  'unspecified',
  'none',
  'n/a',
  'na',
  'unknown',
  'clothes',
  'clothing',
  'outfit',
  'attire',
]);

export function tokenizeAppearance(
  value: string | null | undefined
): Set<string> {
  if (!value) return new Set();
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(
      (token) =>
        token.length > 2 &&
        !STOPWORDS.has(token) &&
        !GENERIC_CLOTHING.has(token)
    );
  return new Set(tokens);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

function talentLookTokens(input: ReuseTalentSheetInput): Set<string> {
  return tokenizeAppearance(
    [
      input.talentClothing,
      input.talentFeatures,
      input.talentPhysical,
      input.talentDescription,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

/**
 * True when the talent sheet already matches the role closely enough that
 * generating a new 4-panel would only resample the same person in the same
 * clothes.
 */
export function shouldReuseTalentSheet(input: ReuseTalentSheetInput): boolean {
  const characterClothes = tokenizeAppearance(input.characterClothing);
  const characterFeatures = tokenizeAppearance(input.characterFeatures);
  const talentLook = talentLookTokens(input);

  if (characterClothes.size > 0) {
    if (talentLook.size === 0) return false;
    if (jaccard(characterClothes, talentLook) < 0.25) return false;
  }

  if (characterFeatures.size > 0) {
    if (talentLook.size === 0) return false;
    if (jaccard(characterFeatures, talentLook) < 0.2) return false;
  }

  return true;
}
