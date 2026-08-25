/**
 * Chrome auto-translate swaps every text node for `<font>` wrappers. React
 * still holds the old nodes, so its next `removeChild` / `insertBefore` on
 * them throws NotFoundError and the nearest boundary shows "Something went
 * wrong" (#1283, facebook/react#11538). Swallow just that case: a child that
 * is no longer ours is already gone; a reference node that is no longer ours
 * means append. Worst case a translated string goes stale instead of the
 * page dying. The ProseMirror editor opts out of translation entirely.
 */

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'translate-guard']);

type NodeProto = Pick<Node, 'removeChild' | 'insertBefore'>;

export function installTranslateGuard(proto: NodeProto = Node.prototype): void {
  const { removeChild, insertBefore } = proto;
  let reported = false;
  const report = (op: string) => {
    if (reported) return;
    reported = true;
    logger.warn(`${op} on a node the page no longer owns (translated?)`);
  };

  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) {
      report('removeChild');
      return child;
    }
    return removeChild.call(this, child) as T;
  };

  proto.insertBefore = function <T extends Node>(
    this: Node,
    node: T,
    ref: Node | null
  ): T {
    if (ref && ref.parentNode !== this) {
      report('insertBefore');
      return insertBefore.call(this, node, null) as T;
    }
    return insertBefore.call(this, node, ref) as T;
  };
}
