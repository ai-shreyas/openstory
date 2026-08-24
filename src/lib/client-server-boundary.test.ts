/**
 * Client/server import-boundary guard (#1253, #1257).
 *
 * In dev, rolldown-vite serves the browser the transitive import graph with
 * no dead-code elimination — a client-reachable module that imports one pure
 * helper from a server-heavy module ships that module's entire dependency
 * tree. This once put the @tanstack/ai adapter family (~10MB), the Stripe
 * Node SDK, and drizzle-orm/libsql in the browser on every sequence page.
 *
 * The walk starts from the client-side roots (`src/components`, `src/hooks`,
 * and `src/functions` — the RPC surface the client imports for its stubs) and
 * fails if any path reaches a server-only module.
 *
 * Server fn files are walked THE WAY THE START COMPILER SHIPS THEM (#1257):
 * `.handler(…)` and `.server(…)` bodies are compiled out of the client bundle
 * and their now-unused imports dead-code-eliminated, but everything else —
 * module-level statements, exported helpers, validator schemas, middleware
 * chains — survives. So this test blanks handler/server-callback bodies
 * first, then follows only the imports still referenced by the surviving
 * code. That is exactly why heavy server logic must live in `src/lib/**` and
 * be referenced ONLY inside handler bodies — an exported helper in a
 * `functions/` file ships its whole graph to the browser.
 *
 * If this test fails: don't extend the allowlist — move the offending helper
 * out of the `functions/` file into a server-side `src/lib/**` module (see
 * `src/lib/ai/script-enhancement.ts`), or move the pure part you need into a
 * client-safe module (see `src/lib/motion/snap-duration.ts`).
 */

import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC = resolve(__dirname, '..', '..');

/** Bare specifiers (or prefixes) that must never be reachable from client code. */
const SERVER_ONLY = [
  'stripe',
  '#db-client',
  '#storage',
  '@tanstack/ai', // core: chat orchestrator + otel middleware — server-side only
  '@tanstack/ai-openrouter',
  '@tanstack/ai-grok',
  '@tanstack/ai-fal',
  '@opentelemetry/',
  '@libsql/',
  'drizzle-orm/libsql',
  'better-auth', // server package; client-safe subpaths are allowlisted below
  'cloudflare:workers',
];
// `#env` is deliberately NOT listed: client modules import it today and the
// browser build resolves it to a runtime shim with no baked-in secrets.

/** Client-side entry points of packages whose root is server-only. */
const CLIENT_SAFE = ['better-auth/client', 'better-auth/react'];

const CLIENT_ROOTS = ['src/components', 'src/hooks', 'src/functions'];

function isServerOnly(spec: string): boolean {
  if (CLIENT_SAFE.some((s) => spec === s || spec.startsWith(`${s}/`))) {
    return false;
  }
  return SERVER_ONLY.some(
    (s) => spec === s || spec.startsWith(s.endsWith('/') ? s : `${s}/`)
  );
}

function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null; // bare specifier — checked against SERVER_ONLY, not walked
  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * API routes are server-only route handlers the client router never imports —
 * their graph is not walked.
 */
function isServerRoute(file: string): boolean {
  return file.includes('/routes/api/');
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(p);
    else if (/\.tsx?$/.test(p) && !/\.(test|spec|stories)\./.test(p)) yield p;
  }
}

function isAstNode(value: object): value is Node {
  return 'type' in value && typeof value.type === 'string';
}

/** Recursively collect nodes, no @babel/traverse needed. */
function* walkAst(value: unknown): Generator<Node> {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) yield* walkAst(item);
    return;
  }
  if (!isAstNode(value)) return;
  yield value;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'loc' ||
      key === 'leadingComments' ||
      key === 'trailingComments'
    ) {
      continue;
    }
    yield* walkAst(child);
  }
}

/** Babel ranges are always set when parsing from source. */
const span = (node: {
  start?: number | null;
  end?: number | null;
}): [number, number] => [node.start ?? 0, node.end ?? 0];

type ModuleImport = {
  /** The import specifier, e.g. '@/lib/db/scoped'. */
  spec: string;
  /** Local binding names ('*' namespace included); empty = side-effect import. */
  names: string[];
  /** Source range of the declaration, blanked before reference counting. */
  start: number;
  end: number;
};

/**
 * The imports of `file` that survive the Start compiler's CLIENT transform:
 * `.handler(…)` / `.server(…)` call arguments are blanked (the compiler
 * replaces them with RPC stubs), non-exported top-level declarations that end
 * up unreferenced are dead-code-eliminated to a fixpoint (mirroring the
 * compiler's babel-dead-code-elimination pass), and then only imports whose
 * bindings are still referenced in the remaining source are returned.
 * Type-only imports pull no runtime dependency and are skipped. Dynamic
 * `import()` is the sanctioned escape hatch for genuinely shared modules —
 * Vite loads it lazily, so it never ships unless executed.
 */
function retainedImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
    errorRecovery: true,
  });

  const imports: ModuleImport[] = [];
  const blank: Array<[number, number]> = [];

  // Comments and TS type positions are erased before the compiler's DCE runs,
  // so a name mentioned only in a docblock or a type annotation must not keep
  // its import alive. TS nodes are blanked wholesale except the ones that
  // contain runtime expressions (their nested type children are still blanked
  // individually as the walk reaches them).
  const VALUE_LEVEL_TS_NODES = new Set([
    'TSAsExpression',
    'TSSatisfiesExpression',
    'TSNonNullExpression',
    'TSInstantiationExpression',
    'TSEnumDeclaration',
    'TSEnumMember',
    'TSModuleDeclaration',
    'TSModuleBlock',
    'TSParameterProperty',
    'TSImportEqualsDeclaration',
    'TSExportAssignment',
  ]);
  for (const comment of ast.comments ?? []) {
    blank.push(span(comment));
  }

  for (const node of walkAst(ast.program)) {
    if (node.type.startsWith('TS') && !VALUE_LEVEL_TS_NODES.has(node.type)) {
      blank.push(span(node));
      continue;
    }
    if (node.type === 'ImportDeclaration') {
      if (node.importKind === 'type') continue;
      const names = node.specifiers
        .filter((s) => s.type !== 'ImportSpecifier' || s.importKind !== 'type')
        .map((s) => s.local.name);
      // Skip declarations where every named specifier is type-only.
      if (node.specifiers.length > 0 && names.length === 0) continue;
      const [start, end] = span(node);
      imports.push({ spec: node.source.value, names, start, end });
      continue;
    }
    // Value re-exports (`export … from 'x'`) always survive the transform.
    if (
      (node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.source &&
      node.exportKind !== 'type'
    ) {
      const [start, end] = span(node);
      imports.push({ spec: node.source.value, names: ['*'], start, end });
      continue;
    }
    // `x.handler(fn)` / `x.server(fn)` — blank the argument list.
    if (node.type === 'CallExpression') {
      const { callee } = node;
      if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        (callee.property.name === 'handler' ||
          callee.property.name === 'server')
      ) {
        blank.push([span(callee)[1], span(node)[1]]);
      }
    }
  }

  // Non-exported top-level declarations are DCE candidates: the compiler
  // removes them when nothing references them after handler stripping (e.g. a
  // private helper only handlers called), which in turn frees their imports.
  const dceCandidates: Array<{ names: string[]; start: number; end: number }> =
    [];
  for (const node of ast.program.body) {
    const names: string[] = [];
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'ClassDeclaration'
    ) {
      if (node.id?.name) names.push(node.id.name);
    } else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id.type === 'Identifier') names.push(d.id.name);
        else names.length = 0; // destructuring — keep conservative
      }
    }
    if (names.length > 0) {
      const [start, end] = span(node);
      dceCandidates.push({ names, start, end });
    }
  }

  // Blank handler bodies and import declarations, then eliminate unreferenced
  // private declarations to a fixpoint before checking import references.
  // split('') keeps UTF-16 code-unit indexing, matching babel's offsets
  // (a code-point spread would shift every position after an emoji).
  const chars = source.split('');
  const blankRange = (start: number, end: number) => {
    for (let i = start; i < end; i++) chars[i] = ' ';
  };
  for (const [start, end] of blank) blankRange(start, end);
  for (const { start, end } of imports) blankRange(start, end);

  const referenced = (name: string, survivors: string) =>
    new RegExp(`\\b${name}\\b`).test(survivors);

  let changed = true;
  const eliminated = new Set<(typeof dceCandidates)[number]>();
  while (changed) {
    changed = false;
    const survivors = chars.join('');
    for (const candidate of dceCandidates) {
      if (eliminated.has(candidate)) continue;
      // Occurrences inside the declaration itself don't keep it alive.
      const outside =
        survivors.slice(0, candidate.start) + survivors.slice(candidate.end);
      if (candidate.names.some((name) => referenced(name, outside))) continue;
      blankRange(candidate.start, candidate.end);
      eliminated.add(candidate);
      changed = true;
    }
  }
  const survivors = chars.join('');

  return imports
    .filter(
      ({ names }) =>
        names.length === 0 || // side-effect import: always survives
        names.includes('*') ||
        names.some((name) => new RegExp(`\\b${name}\\b`).test(survivors))
    )
    .map(({ spec }) => spec);
}

describe('client/server import boundary', () => {
  test('no server-only module is reachable from client components/hooks/functions', () => {
    const visited = new Set<string>();
    // file → the import edge that got us there, for a readable failure trail.
    const cameFrom = new Map<string, string>();
    const queue: string[] = [];
    for (const root of CLIENT_ROOTS) {
      for (const f of walkFiles(join(SRC, root))) queue.push(f);
    }

    const violations: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop();
      if (!file || visited.has(file)) continue;
      visited.add(file);

      for (const spec of retainedImports(file)) {
        if (isServerOnly(spec)) {
          const trail: string[] = [file.replace(`${SRC}/`, '')];
          for (let at = file; cameFrom.has(at);) {
            const prev = cameFrom.get(at);
            if (prev === undefined) break;
            trail.unshift(prev.replace(`${SRC}/`, ''));
            at = prev;
          }
          violations.push(`${trail.join('\n    → ')}\n    → "${spec}"`);
          continue;
        }
        const target = resolveLocal(file, spec);
        if (!target || visited.has(target) || isServerRoute(target)) continue;
        cameFrom.set(target, file);
        queue.push(target);
      }
    }

    expect(
      violations,
      `Server-only imports reachable from client code:\n\n${violations.join('\n\n')}\n\nMove the offending helper into a server-side src/lib module (referenced only from handler bodies) instead of widening this list.`
    ).toEqual([]);
  });
});
