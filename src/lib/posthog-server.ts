import { createServerOnlyFn } from '@tanstack/react-start';
import { PostHog } from 'posthog-node';

let posthogClient: PostHog | null = null;

/**
 * Server-only PostHog (analytics) client. Wrapped in `createServerOnlyFn` so the
 * `posthog-node` import is dead-code-eliminated from the client bundle:
 * `posthog-node` runs Node-only stack-trace parsing at module scope that throws
 * in the browser, so it must never be reachable from a client chunk no matter
 * which server module (AI OTel middleware, style popularity, webhooks…) pulls it
 * in.
 */
export const getPostHogClient = createServerOnlyFn((): PostHog | null => {
  if (!posthogClient) {
    const projectToken =
      process.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN ||
      import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;

    if (!projectToken) {
      // Gracefully return null if PostHog is not configured
      // logger.warn('PostHog is not configured');
      return null;
    }
    posthogClient = new PostHog(projectToken, {
      host:
        process.env.VITE_PUBLIC_POSTHOG_HOST ||
        import.meta.env.VITE_PUBLIC_POSTHOG_HOST ||
        'https://us.i.posthog.com',
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return posthogClient;
});
