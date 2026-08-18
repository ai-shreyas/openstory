import {
  DARK_MODE_DEFAULT_FLAG,
  applyDarkModeVariant,
  parseDarkModeVariant,
  readDarkModeOverride,
  writeBrowserDarkModeCookies,
} from '@/lib/theme/dark-mode-experiment';
import { usePostHog } from '@posthog/react';
import { useEffect, type FC } from 'react';

/**
 * Applies the `dark-mode-default` experiment (#1186).
 *
 * Production: `getFeatureFlag` records exposure, then we persist the variant
 * and toggle `html.dark`. Local / preview: override only (`?os_dark_mode=`
 * or `localStorage os:dark-mode-default`). Evaluation stays in an effect so
 * SSR never touches the PostHog JS client.
 */
export const DarkModeExperiment: FC<{ evaluate: boolean }> = ({ evaluate }) => {
  const posthog = usePostHog();

  useEffect(() => {
    const override = readDarkModeOverride();
    if (override) {
      applyDarkModeVariant(override);
      return;
    }

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime: undefined when PostHogProvider is not mounted
    if (!evaluate || typeof posthog?.getFeatureFlag !== 'function') return;

    const applyFlag = () => {
      const variant = parseDarkModeVariant(
        posthog.getFeatureFlag(DARK_MODE_DEFAULT_FLAG)
      );
      if (!variant) return;
      writeBrowserDarkModeCookies({
        variant,
        distinctId: posthog.get_distinct_id(),
      });
      applyDarkModeVariant(variant);
    };

    applyFlag();
    return posthog.onFeatureFlags(applyFlag);
  }, [evaluate, posthog]);

  return null;
};
