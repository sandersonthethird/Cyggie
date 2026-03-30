/**
 * Pitch Deck Ingestion Service
 *
 * Extracts structured company profile data from pitch decks via three paths:
 *
 *   PDF text path (primary):
 *     filePath → readLocalFile() (pdf-parse) → text → Claude LLM → PitchDeckExtractionResult
 *
 *   PDF vision path (fallback for image-only PDFs):
 *     filePath → readFileSync() → base64 → Claude vision (document API) → PitchDeckExtractionResult
 *
 *   URL path:
 *     url → hidden Electron BrowserWindow → document.body.innerText → Claude LLM → PitchDeckExtractionResult
 *
 * Contacts extracted are founders and C-suite officers ONLY (no advisors, board, investors).
 * CEO is flagged via isCeo for primary contact assignment.
 */

import { BrowserWindow } from 'electron'
import { readFileSync } from 'fs'
import { basename } from 'path'
import { readLocalFile } from '../storage/file-manager'
import { safeParseJson, extractString, extractNumber } from '../utils/json-utils'
import type { LLMProvider } from '../llm/provider'
import type { ChatAttachment } from '../../shared/types/chat'
import type { PitchDeckExtractionResult } from '../../shared/types/pitch-deck'
import type { CompanyRound, CompanyEntityType } from '../../shared/types/company'

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type PitchDeckErrorCode =
  | 'file_not_found'
  | 'no_text'
  | 'image_only'
  | 'image_only_vision_failed'
  | 'no_data'
  | 'llm_failed'
  | 'llm_bad_json'
  | 'url_invalid'
  | 'url_timeout'
  | 'url_load_failed'
  | 'url_auth_failed'

export class PitchDeckError extends Error {
  constructor(
    public readonly code: PitchDeckErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PitchDeckError'
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_TEXT_LENGTH = 100     // below this → likely image-only PDF
const URL_TIMEOUT_MS  = 15_000  // 15s BrowserWindow load timeout

const VALID_ROUNDS: CompanyRound[] = [
  'pre_seed', 'seed', 'seed_extension', 'series_a', 'series_b',
]

const VALID_ENTITY_TYPES: CompanyEntityType[] = [
  'startup', 'vc_fund', 'family_office', 'angel', 'accelerator', 'corporate', 'other',
]

// Titles that indicate CEO / Co-CEO
const CEO_TITLE_PATTERNS = [/\bCEO\b/i, /chief\s+executive/i, /co[-\s]?ceo/i]

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return (
    'You are a company data extractor. Extract structured information from a pitch deck. ' +
    'Return ONLY valid JSON — no prose, no markdown fences. Set fields to null if not mentioned. ' +
    'For contacts: include ONLY founders and C-suite officers (CEO, CTO, CFO, COO, CPO, etc.). ' +
    'Exclude advisors, board members, investors, and non-executive team members entirely.'
  )
}

function buildUserPrompt(sourceLabel: string, text: string): string {
  return (
    `Extract company information from this pitch deck: ${sourceLabel}\n\n` +
    `Deck content:\n${text}\n\n` +
    `Return a JSON object with these fields:\n` +
    `{\n` +
    `  "companyName": company name (string or null),\n` +
    `  "description": one-sentence company description (string or null),\n` +
    `  "domain": primary domain e.g. "acme.com" (string or null),\n` +
    `  "websiteUrl": full website URL (string or null),\n` +
    `  "city": headquarters city (string or null),\n` +
    `  "state": headquarters state abbreviation (string or null),\n` +
    `  "sector": primary sector / industry (string or null),\n` +
    `  "businessModel": B2B/B2C/B2B2C/marketplace/etc. (string or null),\n` +
    `  "targetCustomer": description of target customer (string or null),\n` +
    `  "productStage": idea/mvp/beta/live/growth/scale (string or null),\n` +
    `  "round": one of [pre_seed, seed, seed_extension, series_a, series_b] or null,\n` +
    `  "raiseSize": raise size in millions USD as a number (number or null),\n` +
    `  "postMoneyValuation": post-money valuation in millions USD (number or null),\n` +
    `  "entityType": one of [startup, vc_fund, family_office, angel, accelerator, corporate, other] or null,\n` +
    `  "industries": array of industry tags e.g. ["FinTech", "AI/ML"] (array, may be empty),\n` +
    `  "founders": array of founders and C-suite officers ONLY — each: { name, email, title } — exclude advisors/board/investors\n` +
    `}`
  )
}

/**
 * Builds the user prompt for vision-based extraction (image-only PDFs).
 * The deck content is supplied via a PDF document attachment rather than inline text.
 */
function buildVisionUserPrompt(sourceLabel: string): string {
  return (
    `Extract company information from this pitch deck: ${sourceLabel}\n\n` +
    `The deck is provided as an attached PDF. Read all pages carefully, including any image-based text.\n\n` +
    `Return a JSON object with these fields:\n` +
    `{\n` +
    `  "companyName": company name (string or null),\n` +
    `  "description": one-sentence company description (string or null),\n` +
    `  "domain": primary domain e.g. "acme.com" (string or null),\n` +
    `  "websiteUrl": full website URL (string or null),\n` +
    `  "city": headquarters city (string or null),\n` +
    `  "state": headquarters state abbreviation (string or null),\n` +
    `  "sector": primary sector / industry (string or null),\n` +
    `  "businessModel": B2B/B2C/B2B2C/marketplace/etc. (string or null),\n` +
    `  "targetCustomer": description of target customer (string or null),\n` +
    `  "productStage": idea/mvp/beta/live/growth/scale (string or null),\n` +
    `  "round": one of [pre_seed, seed, seed_extension, series_a, series_b] or null,\n` +
    `  "raiseSize": raise size in millions USD as a number (number or null),\n` +
    `  "postMoneyValuation": post-money valuation in millions USD (number or null),\n` +
    `  "entityType": one of [startup, vc_fund, family_office, angel, accelerator, corporate, other] or null,\n` +
    `  "industries": array of industry tags e.g. ["FinTech", "AI/ML"] (array, may be empty),\n` +
    `  "founders": array of founders and C-suite officers ONLY — each: { name, email, title } — exclude advisors/board/investors\n` +
    `}`
  )
}

async function callLlm(
  sourceLabel: string,
  text: string,
  provider: LLMProvider,
  pdfAttachment?: ChatAttachment
): Promise<PitchDeckExtractionResult> {
  const systemPrompt = buildSystemPrompt()
  const userPrompt   = pdfAttachment ? buildVisionUserPrompt(sourceLabel) : buildUserPrompt(sourceLabel, text)
  const attachments  = pdfAttachment ? [pdfAttachment] : undefined

  let responseText: string
  try {
    responseText = await provider.generateSummary(systemPrompt, userPrompt, undefined, undefined, attachments)
  } catch (err) {
    console.error('[PitchDeck] LLM call failed', { sourceLabel, vision: !!pdfAttachment, err })
    throw new PitchDeckError('llm_failed', 'AI extraction failed — please try again')
  }

  const raw = safeParseJson(responseText)
  if (!raw) {
    console.warn('[PitchDeck] LLM returned malformed JSON', { sourceLabel, responseText: responseText.slice(0, 200) })
    throw new PitchDeckError('llm_bad_json', 'AI extraction returned unexpected data — please try again')
  }

  const result = parseExtractionResult(raw, sourceLabel)
  result.rawText = text
  return result
}

function parseExtractionResult(
  raw: Record<string, unknown>,
  sourceLabel: string
): PitchDeckExtractionResult {
  const round       = extractString(raw.round) as CompanyRound | null
  const entityType  = extractString(raw.entityType) as CompanyEntityType | null

  // Parse founders — filter to only those with a name, mark isCeo
  const rawFounders = Array.isArray(raw.founders) ? raw.founders : []
  const founders = rawFounders
    .filter((f): f is Record<string, unknown> => f && typeof f === 'object')
    .map((f) => {
      const title = extractString(f.title)
      const isCeo = title ? CEO_TITLE_PATTERNS.some((p) => p.test(title)) : false
      return {
        name:  extractString(f.name) ?? '',
        email: extractString(f.email),
        title,
        isCeo,
      }
    })
    .filter((f) => f.name.length > 0)

  const result: PitchDeckExtractionResult = {
    companyName:         extractString(raw.companyName),
    description:         extractString(raw.description),
    domain:              extractString(raw.domain),
    websiteUrl:          extractString(raw.websiteUrl),
    city:                extractString(raw.city),
    state:               extractString(raw.state),
    sector:              extractString(raw.sector),
    businessModel:       extractString(raw.businessModel),
    targetCustomer:      extractString(raw.targetCustomer),
    productStage:        extractString(raw.productStage),
    round:               round && VALID_ROUNDS.includes(round) ? round : null,
    raiseSize:           extractNumber(raw.raiseSize),
    postMoneyValuation:  extractNumber(raw.postMoneyValuation),
    entityType:          entityType && VALID_ENTITY_TYPES.includes(entityType) ? entityType : null,
    industries:          Array.isArray(raw.industries)
                           ? (raw.industries as unknown[]).filter((v): v is string => typeof v === 'string')
                           : [],
    founders,
    sourceLabel,
  }

  const allNull = (
    result.companyName === null &&
    result.description === null &&
    result.domain      === null &&
    result.round       === null &&
    result.founders.length === 0
  )

  if (allNull) {
    throw new PitchDeckError('no_data', 'No company data found in this document')
  }

  return result
}

// ---------------------------------------------------------------------------
// PDF extraction
// ---------------------------------------------------------------------------

export async function extractFromPdf(
  filePath: string,
  provider: LLMProvider
): Promise<PitchDeckExtractionResult> {
  const sourceLabel = basename(filePath)
  console.log('[PitchDeck] ingestion started', { source: 'pdf', sourceLabel })

  const text = await readLocalFile(filePath)

  if (text === null) {
    console.warn('[PitchDeck] readLocalFile returned null', { filePath })
    throw new PitchDeckError('no_text', 'Could not read this PDF — it may be corrupted, encrypted, or exceed the 5 MB limit')
  }

  const startMs = Date.now()

  let result: PitchDeckExtractionResult
  // Note: sourceFilePath is set below (outside the if/else) for both text and vision paths.
  if (text.trim().length < MIN_TEXT_LENGTH) {
    // PDF appears image-only — fall back to vision-based extraction via Claude document API
    console.warn('[PitchDeck] PDF text too short, attempting vision fallback', {
      filePath,
      textLength: text.trim().length,
    })
    let pdfBuffer: Buffer
    try {
      pdfBuffer = readFileSync(filePath)
    } catch (err) {
      console.error('[PitchDeck] could not read PDF buffer for vision fallback', { filePath, err })
      throw new PitchDeckError('image_only', 'This PDF appears to be image-only and could not be read for visual extraction')
    }
    const pdfAttachment: ChatAttachment = {
      name: sourceLabel,
      mimeType: 'application/pdf',
      type: 'pdf',
      data: pdfBuffer.toString('base64'),
    }
    try {
      result = await callLlm(sourceLabel, '', provider, pdfAttachment)
      console.log('[PitchDeck] vision extraction complete', {
        source: 'pdf-vision',
        sourceLabel,
        fieldsFound: Object.values(result).filter((v) => v !== null && (!Array.isArray(v) || v.length > 0)).length,
        foundersFound: result.founders.length,
        durationMs: Date.now() - startMs,
      })
    } catch (err) {
      // If vision also fails, give the user a clear message
      const code = err instanceof PitchDeckError ? err.code : 'image_only_vision_failed'
      const message = err instanceof PitchDeckError
        ? err.message
        : 'This PDF appears to be image-only and AI vision extraction also failed — try a text-based version or export from the source application'
      throw new PitchDeckError(code as PitchDeckErrorCode, message)
    }
  } else {
    result = await callLlm(sourceLabel, text, provider)
    console.log('[PitchDeck] extraction complete', {
      source: 'pdf',
      sourceLabel,
      fieldsFound:  Object.values(result).filter((v) => v !== null && (!Array.isArray(v) || v.length > 0)).length,
      foundersFound: result.founders.length,
      durationMs:   Date.now() - startMs,
    })
  }

  result.sourceFilePath = filePath
  return result
}

// ---------------------------------------------------------------------------
// URL extraction (hidden BrowserWindow)
// ---------------------------------------------------------------------------

export async function extractFromUrl(
  url: string,
  opts: { email?: string; password?: string },
  provider: LLMProvider
): Promise<PitchDeckExtractionResult> {
  // Validate URL protocol
  if (!/^https?:\/\//i.test(url)) {
    throw new PitchDeckError('url_invalid', 'URL must start with https://')
  }

  let urlDomain: string
  try {
    urlDomain = new URL(url).hostname
  } catch {
    throw new PitchDeckError('url_invalid', 'Invalid URL — please check and try again')
  }

  const sourceLabel = urlDomain
  console.log('[PitchDeck] ingestion started', { source: 'url', urlDomain })

  const text = await loadUrlContent(url, opts)

  if (text.trim().length < MIN_TEXT_LENGTH) {
    throw new PitchDeckError('url_auth_failed', 'Page loaded but appears empty — check the URL and email address')
  }

  const startMs = Date.now()
  const result  = await callLlm(sourceLabel, text, provider)
  console.log('[PitchDeck] extraction complete', {
    source: 'url',
    sourceLabel,
    fieldsFound:  Object.values(result).filter((v) => v !== null && (!Array.isArray(v) || v.length > 0)).length,
    foundersFound: result.founders.length,
    durationMs:   Date.now() - startMs,
  })

  return result
}

/**
 * Loads a URL in a hidden, sandboxed Electron BrowserWindow and returns the
 * visible text content. Fills email/password fields if the page presents an
 * auth gate and credentials are provided.
 *
 * Uses try/finally to guarantee win.destroy() in all paths.
 */
async function loadUrlContent(
  url: string,
  opts: { email?: string; password?: string }
): Promise<string> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  // Prevent navigation away from the target origin
  win.webContents.on('will-navigate', (event, navUrl) => {
    try {
      const target = new URL(url)
      const nav    = new URL(navUrl)
      if (nav.hostname !== target.hostname) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null

  try {
    await Promise.race([
      win.loadURL(url),
      new Promise<void>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new PitchDeckError('url_timeout', 'Page failed to load — try downloading as PDF instead')),
          URL_TIMEOUT_MS
        )
        win.webContents.on('did-fail-load', (_ev, errorCode, errorDesc) => {
          reject(new PitchDeckError('url_load_failed', `Page failed to load (${errorDesc}) — try downloading as PDF instead`))
        })
      }),
    ])

    if (timeoutHandle) clearTimeout(timeoutHandle)

    // Brief settle wait for JS-rendered content (DocSend renders after load)
    await new Promise<void>((resolve) => setTimeout(resolve, 2000))

    // Fill auth gate if credentials provided
    if (opts.email || opts.password) {
      // Extra settle: let the email gate form itself finish rendering
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))

      // Attach did-finish-load BEFORE clicking submit to avoid a race where a
      // fast post-auth redirect completes before we can register the listener.
      // Falls back to 5s timeout for AJAX-only auth flows with no navigation.
      const waitForLoad = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000)
        win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve() })
      })

      await tryFillAuthForm(win, opts.email ?? null, opts.password ?? null)
      await waitForLoad

      // Check if the email gate is still present after auth — if so, the form
      // fill failed (wrong email, JS error, form not found) and we can give a
      // more actionable error than the generic "page loaded but appears empty".
      const gateStillPresent: boolean = await win.webContents.executeJavaScript(
        '!!document.querySelector(\'input[type="email"], input[name="email"], input[placeholder*="email" i]\')'
      )
      if (gateStillPresent) {
        throw new PitchDeckError(
          'url_auth_failed',
          'Email gate was not bypassed — try downloading the deck as a PDF instead'
        )
      }
    }

    const text: string = await win.webContents.executeJavaScript(
      'document.body ? document.body.innerText : ""'
    )

    return text
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    try { win.destroy() } catch { /* already destroyed */ }
  }
}

/**
 * Attempts to fill and submit an email/password auth form in the given window.
 * Silently no-ops if no form is found — the caller detects auth failure via
 * sparse content after the settle wait.
 */
async function tryFillAuthForm(
  win: BrowserWindow,
  email: string | null,
  password: string | null
): Promise<void> {
  try {
    await win.webContents.executeJavaScript(`
      (function() {
        var emailInput = document.querySelector(
          'input[type="email"], input[name="email"], input[placeholder*="email" i]'
        );
        var passwordInput = document.querySelector('input[type="password"]');
        var submitBtn = document.querySelector(
          'button[type="submit"], input[type="submit"], form button'
        );

        // DocSend (and most gated deck platforms) use React-controlled inputs.
        // Direct DOM assignment (emailInput.value = x) is silently ignored by
        // React because React overrides the native HTMLInputElement value setter.
        // Using the native prototype setter bypasses React's override so that
        // React's synthetic event system detects the change and enables submit.
        var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;

        if (emailInput && ${JSON.stringify(email)}) {
          nativeInputValueSetter.call(emailInput, ${JSON.stringify(email)});
          emailInput.dispatchEvent(new Event('input', { bubbles: true }));
          emailInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (passwordInput && ${JSON.stringify(password)}) {
          nativeInputValueSetter.call(passwordInput, ${JSON.stringify(password)});
          passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
          passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (submitBtn && (emailInput || passwordInput)) {
          submitBtn.click();
        }
      })();
    `)
  } catch (err) {
    console.warn('[PitchDeck] tryFillAuthForm failed silently', err)
  }
}
