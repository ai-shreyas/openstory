/**
 * Models whose provider terms require end-user real-name authentication
 * (#1180).
 *
 * Some model providers make platform-operator obligations a condition of
 * access: if you resell the model to external users, you must verify who those
 * users are and be able to act on violations. Serving such a model to an
 * unverified account is a terms breach on our side, not merely a policy
 * preference — so the list of which models those are needs to live somewhere
 * explicit rather than in someone's memory of a questionnaire.
 *
 * Matching is on `(provider, model)` and is deliberately conservative: the same
 * model reached through different providers carries different obligations.
 * Seedance served by BytePlus/ModelArk under our own ModelArk account makes US
 * the tool platform, and the real-name requirement is ours to satisfy. The same
 * family reached through fal is served under fal's platform terms, where fal is
 * the operator — so it is not listed here, and adding it would demand identity
 * documents from users for no contractual reason.
 *
 * To add a provider: add a rule. Keep the `why` accurate — it is what a future
 * reader will use to decide whether the rule still applies.
 */

export type RestrictedModelRule = {
  /** Provider id as recorded on provenance rows, lowercase. */
  provider: string;
  /**
   * Model/endpoint substring, lowercase. Undefined means every model from this
   * provider is restricted — the right default when the obligation attaches to
   * the account relationship rather than to a specific model.
   */
  modelIncludes?: string;
  /** Why this is restricted. Cite the agreement, not the vibe. */
  why: string;
};

const RESTRICTED_MODEL_RULES: readonly RestrictedModelRule[] = [
  {
    provider: 'modelark',
    why: 'BytePlus ModelArk activation: serving these models to external users makes us the tool platform, which requires end-user real-name authentication and violation handling.',
  },
  {
    provider: 'byteplus',
    why: 'Same BytePlus platform obligations as ModelArk, under the alternate provider id.',
  },
];

/**
 * Does this model require the calling account to hold a verified identity?
 *
 * Unknown provider/model returns false. That is the correct default: this
 * function answers "is there a specific agreement demanding verification", and
 * inventing one for every unrecognized string would gate the whole catalogue
 * the first time a provider id changed spelling. The platform-wide setting
 * (`IDENTITY_VERIFICATION_POLICY=all_generation`) exists for deployments that
 * do want to require it everywhere.
 */
export function isRestrictedModel(opts: {
  provider?: string;
  model?: string;
}): boolean {
  const provider = opts.provider?.trim().toLowerCase();
  if (!provider) return false;
  const model = opts.model?.trim().toLowerCase() ?? '';

  return RESTRICTED_MODEL_RULES.some((rule) => {
    if (rule.provider !== provider) return false;
    if (!rule.modelIncludes) return true;
    return model.includes(rule.modelIncludes);
  });
}

/** The matching rule, for explaining a block in the UI or an audit. */
export function restrictedModelRule(opts: {
  provider?: string;
  model?: string;
}): RestrictedModelRule | undefined {
  const provider = opts.provider?.trim().toLowerCase();
  if (!provider) return undefined;
  const model = opts.model?.trim().toLowerCase() ?? '';
  return RESTRICTED_MODEL_RULES.find(
    (rule) =>
      rule.provider === provider &&
      (!rule.modelIncludes || model.includes(rule.modelIncludes))
  );
}
