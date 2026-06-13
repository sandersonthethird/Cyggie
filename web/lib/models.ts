/**
 * Fallback Claude model for web-chat surfaces (meeting / memo / note share pages).
 *
 * The live, per-firm choice is stored in `app_config (firm_id, 'webChatModel')`
 * and pushed up from the desktop Settings → "Web Chat" dropdown. This constant is
 * used when no config row exists yet (pre-push) or the share has no firm_id
 * (pre-onboarding / pre-migration share). It mirrors the historically hardcoded
 * model so behavior is unchanged until a firm picks something else.
 */
export const WEB_CHAT_DEFAULT_MODEL = 'claude-sonnet-4-6'

/** Settings key under which the web-chat model is stored per firm. */
export const WEB_CHAT_MODEL_CONFIG_KEY = 'webChatModel'
