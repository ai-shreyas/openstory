import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { findExpensiveBackfills } from '../../../scripts/check-migrations';

/** Write `sql` to a throwaway migration file and return its path. */
function migrationFile(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-migrations-'));
  const path = join(dir, 'migration.sql');
  writeFileSync(path, sql);
  return path;
}

describe('findExpensiveBackfills (#1019 per-row subquery guard)', () => {
  it('flags a scalar subquery in an UPDATE SET', () => {
    const path = migrationFile(
      `UPDATE shots SET x = (SELECT id FROM other o WHERE o.shot_id = shots.id LIMIT 1);`
    );
    const findings = findExpensiveBackfills(path);
    expect(findings.some((f) => f.kind.includes('scalar'))).toBe(true);
  });

  it('flags a correlated EXISTS subquery in WHERE', () => {
    const path = migrationFile(
      `UPDATE shots SET x = 1 WHERE EXISTS (SELECT 1 FROM other o WHERE o.shot_id = shots.id);`
    );
    expect(
      findExpensiveBackfills(path).some((f) => f.kind.includes('EXISTS'))
    ).toBe(true);
  });

  it('does NOT flag a set-based `UPDATE … FROM (<join>)`', () => {
    const path = migrationFile(
      `UPDATE shots
       SET selected = latest.v
       FROM (SELECT shot_id, id AS v FROM other) AS latest
       WHERE shots.id = latest.shot_id AND shots.selected IS NULL;`
    );
    expect(findExpensiveBackfills(path)).toEqual([]);
  });

  it('ignores subquery patterns that appear only in SQL comments', () => {
    const path = migrationFile(
      `-- Set-based, NOT a per-row \`= (SELECT …)\` or \`WHERE EXISTS (SELECT …)\`.
       UPDATE shots
       SET selected = latest.v
       FROM (SELECT shot_id, id AS v FROM other) AS latest
       WHERE shots.id = latest.shot_id;`
    );
    expect(findExpensiveBackfills(path)).toEqual([]);
  });
});
