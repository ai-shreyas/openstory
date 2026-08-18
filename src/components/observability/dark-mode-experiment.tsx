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
 * Production (`evaluate`): `getFeatureFlag` records exposure, then we persist
 * the variant and toggle `html.dark`. Overrides (`?os_dark_mode=` /
 * `localStorage`) are local / preview only — a leftover key on production
 * must not skip exposure.
 */
export const DarkModeExperiment: FC<{ evaluate: boolean }> = ({ evaluate }) => {
  const posthog = usePostHog();

  useEffect(() => {
    if (!evaluate) {
      const override = readDarkModeOverride();
      if (override) applyDarkModeVariant(override);
      return;
    }

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime: undefined when PostHogProvider is not mounted
    if (typeof posthog?.getFeatureFlag !== 'function') return;

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
