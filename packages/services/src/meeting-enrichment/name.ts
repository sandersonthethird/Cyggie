// Company-name resolution for a single domain — the slow tiers of the desktop's
// enrichCompanyInner (homepage parse → LLM → deterministic heuristic), with all
// I/O injected so it runs identically on desktop (electron.net fetch +
// getProvider) and gateway (WebShare-proxied fetch + ClaudeProvider).
//
// PRECEDENCE NOTE: the authoritative org_companies lookup and the legacy
// `companies` cache (tiers 0-1 in the desktop) are the CALLER's responsibility —
// they're DB reads the caller already batches. resolveCompanyName is only the
// network/LLM/heuristic fallback for a domain with no known company.
//
//   fetchHtml(domain) ─▶ parseCompanyName ─▶ isPlausible? ──┐
//        │null/throw          │null              │no          ▼
//        ▼                    ▼                  └──▶ llm.generateSummary ─▶ isPlausible?
//   (skip homepage tier)                                │null/throw/UNKNOWN   │no
//                                                       ▼                     ▼
//                                              domainToTitleCase(domain)  ◀───┘  (always non-null)

import type { LLMProvider } from '../llm/provider'
import { domainToTitleCase, isPlausibleCompanyName, parseCompanyName } from './helpers'

export interface ResolveCompanyNameDeps {
  /**
   * Fetch a domain's homepage HTML, or null when unavailable/blocked. The
   * caller owns the transport + its safety: desktop uses electron.net; the
   * gateway routes through the WebShare proxy (so it never connects to
   * attacker-controlled internal IPs) and passes null when no proxy is
   * configured. Must not throw — but resolveCompanyName catches anyway.
   */
  fetchHtml: (domain: string) => Promise<string | null>
  /** LLM fallback for name resolution, or null to skip the LLM tier. */
  llm: LLMProvider | null
}

/** Ask the LLM for a brand name; null on failure/low-confidence/UNKNOWN. */
async function resolveViaLLM(domain: string, llm: LLMProvider): Promise<string | null> {
  try {
    const raw = (
      await llm.generateSummary(
        'You identify a company by its official brand name only.',
        `What is the official company/brand name of the business at the domain "${domain}"?\n\n` +
          `Rules:\n` +
          `- Reply with ONLY the short brand name (e.g. "Stripe", "CapHub", "Andreessen Horowitz").\n` +
          `- Do NOT reply with a tagline, slogan, or description of what the company does.\n` +
          `- If you are not confident of the real name, reply with exactly: UNKNOWN`,
      )
    ).trim()
    const name = raw.replace(/^["'“”]+|["'“”.]+$/g, '').trim()
    if (name.toUpperCase() === 'UNKNOWN') return null
    if (name.length >= 2 && name.length <= 100 && !name.includes('\n')) return name
  } catch (err) {
    console.error(`[meeting-enrichment] LLM company resolution failed for ${domain}:`, err)
  }
  return null
}

/**
 * Resolve a display name for a domain with no known company: homepage parse →
 * LLM → deterministic heuristic. Always returns a non-empty name (the heuristic
 * never fails), so a transient fetch/LLM failure degrades to a humanized domain
 * rather than no name.
 */
export async function resolveCompanyName(
  domain: string,
  deps: ResolveCompanyNameDeps,
): Promise<string> {
  // Tier 2: homepage parse (gated by plausibility — sites put taglines in <title>).
  let html: string | null = null
  try {
    html = await deps.fetchHtml(domain)
  } catch (err) {
    console.error(`[meeting-enrichment] homepage fetch failed for ${domain}:`, err)
  }
  const parsed = html ? parseCompanyName(html) : null
  let displayName = parsed && isPlausibleCompanyName(parsed) ? parsed : null

  // Tier 3: LLM fallback (also plausibility-gated — the LLM tends to describe).
  if (!displayName && deps.llm) {
    const llmName = await resolveViaLLM(domain, deps.llm)
    displayName = llmName && isPlausibleCompanyName(llmName) ? llmName : null
  }

  // Tier 4: deterministic heuristic — worse label, never a hallucinated tagline.
  return displayName ?? domainToTitleCase(domain)
}
