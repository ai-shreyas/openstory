/**
 * Deduplication ids for `/library-talent-sheet`.
 *
 * Generate-if-missing (create, or the first photos on a sheetless talent)
 * shares one id per talent so parallel finalizes reuse the in-flight run
 * instead of billing N 4-panels. Explicit "Generate Sheet" omits this id
 * so a later click can roll a new sheet. Uploaded sheets are keyed by the
 * stored object's last path segment so two different sheets both promote.
 */

export function libraryTalentGenerateDedupId(talentId: string): string {
  return `library-talent-sheet:generate:${talentId}`;
}

export function libraryTalentUploadDedupId(
  talentId: string,
  sheetUrl: string
): string {
  const tail =
    sheetUrl
      .split('/')
      .pop()
      ?.replace(/[^a-zA-Z0-9._-]/g, '') ?? 'sheet';
  return `library-talent-sheet:upload:${talentId}:${tail}`;
}
