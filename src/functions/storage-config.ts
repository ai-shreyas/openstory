import { getEnv } from '#env';
import { createServerFn } from '@tanstack/react-start';

/**
 * Public storage config for the client (#873). `R2_PUBLIC_STORAGE_DOMAIN` is
 * server-only, but the scene editor's optimised-prompt preview wants to show
 * the exact CDN URLs fal will receive — the domain itself is public knowledge
 * (it appears in every media redirect), so exposing it needs no auth.
 */
export const getStorageDomainFn = createServerFn({ method: 'GET' }).handler(
  () => ({
    storageDomain: getEnv().R2_PUBLIC_STORAGE_DOMAIN ?? null,
  })
);
