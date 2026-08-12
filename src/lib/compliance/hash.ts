/**
 * Hashing helpers for compliance records (#1180).
 *
 * Everything here uses WebCrypto's SHA-256, available in Workerd and Node
 * alike, so the same code runs in a workflow step, a server fn, and a test.
 *
 * Why compliance records store hashes instead of the values:
 *
 *  - A prompt hash proves which prompt produced an asset without keeping a
 *    second, divergent copy of user content that then has to be deleted on
 *    request, exported on request, and kept accurate forever.
 *  - An identity hash answers "is this the same legal person as that other
 *    account?" without our database ever holding the person's name.
 *  - An attestation-statement hash pins the exact wording a user agreed to,
 *    so a later edit to the wording cannot be read back onto an old consent.
 */

const encoder = /* @__PURE__ */ new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toHex(digest);
}

/**
 * Normalize a personal name before hashing so trivial presentation differences
 * ("  Ada  LOVELACE " vs "Ada Lovelace") produce the same digest, and one
 * identity cannot farm accounts just by retyping their name differently.
 *
 * Deliberately conservative: case-folds, collapses whitespace, and strips
 * combining marks via NFKD so "José" and "José" agree. It does NOT strip
 * accents' base letters, reorder name parts, or transliterate scripts —
 * heuristics like those create false matches between different people, and a
 * false "this identity already verified another account" is a worse failure
 * than a missed duplicate.
 */
export function normalizeSubjectName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{Mn}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Salted hash of a verified legal name, for duplicate-identity detection.
 *
 * Returns null when no salt is configured — deliberately, rather than falling
 * back to an unsalted digest. The space of real names is small enough to
 * enumerate, so an unsalted hash column is a reversible list of our verified
 * users' names; better to lose duplicate detection than to ship that.
 */
export async function hashSubjectName(
  name: string,
  salt: string | undefined
): Promise<string | null> {
  const trimmed = salt?.trim();
  if (!trimmed) return null;
  const normalized = normalizeSubjectName(name);
  if (!normalized) return null;
  return sha256Hex(`${trimmed}:${normalized}`);
}
