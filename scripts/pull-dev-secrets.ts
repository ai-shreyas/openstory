/**
 * Download the Doppler `openstory` / `dev` config into `.env.local`.
 *
 * Requires the Doppler CLI (`doppler login` once). Overwrites `.env.local`.
 *
 * Usage:
 *   bun secrets:dev
 *   bun scripts/pull-dev-secrets.ts
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT = 'openstory';
const CONFIG = 'dev';
const OUT = resolve(process.cwd(), '.env.local');

function main() {
  const result = spawnSync(
    'doppler',
    [
      'secrets',
      'download',
      '--project',
      PROJECT,
      '--config',
      CONFIG,
      '--format',
      'env',
      '--no-file',
    ],
    {
      encoding: 'utf8',
      // Capture stdout (secrets); show stderr for auth/errors.
      stdio: ['ignore', 'pipe', 'inherit'],
    }
  );

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(
        'doppler CLI not found. Install: https://docs.doppler.com/docs/install-cli'
      );
    } else {
      console.error(result.error.message);
    }
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(
      `doppler secrets download failed (exit ${result.status ?? 'signal'}).` +
        ` Run \`doppler login\` and confirm you can access project "${PROJECT}".`
    );
    process.exit(1);
  }

  const body = result.stdout;
  if (!body.trim()) {
    console.error(
      'Doppler returned an empty secret set — refusing to overwrite .env.local'
    );
    process.exit(1);
  }

  writeFileSync(OUT, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  console.log(`Wrote Doppler ${PROJECT}/${CONFIG} secrets → .env.local`);
}

main();
