/**
 * Client/server import-boundary guard (#1253).
 *
 * In dev, rolldown-vite serves the browser the FULL transitive import graph
 * with no dead-code elimination — a client component importing one pure
 * helper from a server-heavy module ships that module's entire dependency
 * tree. This once put the @tanstack/ai adapter family (~9MB), the Stripe
 * Node SDK, and drizzle-orm/libsql in the browser on every sequence page.
 *
 * This test walks the static import graph from the client-side roots
 * (`src/components`, `src/hooks`) and fails if any path reaches a
 * server-only module. Imports of `src/functions/**` are NOT followed:
 * that's the RPC boundary — server fns are compiled to fetch stubs for the
 * client in production (their dev-mode weight is #<follow-up issue> / lazy
 * handler imports).
 *
 * If this test fails: don't extend the allowlist — move the helper you need
 * into a client-safe module (see `src/lib/motion/snap-duration.ts`).
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const SRC = resolve(__dirname, '..', '..');

/** Bare specifiers (or prefixes) that must never be reachable from client code. */
const SERVER_ONLY = [
  'stripe',
  '#db-client',
  '#storage',
  '@tanstack/ai-openrouter',
  '@tanstack/ai-grok',
  '@tanstack/ai-fal',
  '@libsql/',
  'drizzle-orm/libsql',
  'better-auth', // server package; client-safe subpaths are allowlisted below
  'cloudflare:workers',
];
// `#env` is deliberately NOT listed: client modules import it today and the
// browser build resolves it to a runtime shim with no baked-in secrets.

/** Client-side entry points of packages whose root is server-only. */
const CLIENT_SAFE = ['better-auth/client', 'better-auth/react'];

const CLIENT_ROOTS = ['src/components', 'src/hooks'];

// `import type` / `export type` are erased at compile time and pull no
// runtime dependency — skip them (the negative lookahead on `type\s`).
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/g;

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
 * The RPC boundary: server fns become fetch stubs on the client, and the
 * Start compiler strips their handler-only imports from the client build.
 * That's true for `src/functions/**`, API routes, and any module that calls
 * `createServerFn` (e.g. `lib/auth/server.ts`) — dev still serves their full
 * graph, but that's the follow-up issue's scope, not this guard's.
 */
function isRpcBoundary(file: string): boolean {
  if (file.includes('/functions/') || file.includes('/routes/api/')) {
    return true;
  }
  return /\bcreateServerFn\s*\(/.test(readFileSync(file, 'utf8'));
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(p);
    else if (/\.tsx?$/.test(p) && !/\.(test|spec|stories)\./.test(p)) yield p;
  }
}

// Static imports only. Dynamic `import()` is the sanctioned escape hatch —
// Vite loads it lazily (a separate chunk, fetched only when executed), so a
// server-only dynamic import in a shared module never reaches the browser
// as long as the client code path doesn't call it (see fal-cost.ts).
function imports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specs: string[] = [];
  IMPORT_RE.lastIndex = 0;
  for (let m = IMPORT_RE.exec(source); m; m = IMPORT_RE.exec(source)) {
    const spec = m[1];
    if (spec) specs.push(spec);
  }
  return specs;
}

describe('client/server import boundary', () => {
  test('no server-only module is reachable from client components/hooks', () => {
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

      for (const spec of imports(file)) {
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
        if (!target || visited.has(target) || isRpcBoundary(target)) continue;
        cameFrom.set(target, file);
        queue.push(target);
      }
    }

    expect(
      violations,
      `Server-only imports reachable from client code:\n\n${violations.join('\n\n')}\n\nMove the needed helper into a client-safe module instead of widening this list.`
    ).toEqual([]);
  });
});
