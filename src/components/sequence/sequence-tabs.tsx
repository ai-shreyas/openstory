/**
 * Sequence sub-routes are not a tab strip.
 *
 * - Pre-analysis: `/script` is the composer (no alternative tab).
 * - Post-analysis: `/scenes` is the editor; script is a canvas view toggle
 *   (`view=script`), not a sibling page (#1037 / #986).
 *
 * The old Script | Scenes chip bar was leftover dual-page chrome and must
 * never render (#1072).
 */

/** Default deep-link for a sequence breadcrumb / "open sequence" landing. */
export function getDefaultSequenceTabPath(sequenceId: string): string {
  return `/sequences/${sequenceId}/script`;
}
