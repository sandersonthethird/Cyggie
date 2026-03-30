/**
 * Shared VC pitch deck analysis service.
 *
 * Produces a two-section LLM response from a pitch deck extraction result:
 *   1. ## Partner Sync Summary — structured brief fields
 *   2. ## Full Analysis — 8-section VC investment analysis
 *
 * Used by both partner-meeting.ipc.ts (sync + note flow) and
 * company.ipc.ts (note-only flow via COMPANY_ANALYZE_FILE).
 *
 * For vision PDFs (rawText = ''), re-reads the file from sourceFilePath to
 * pass as a PDF attachment rather than serializing base64 over IPC twice.
 */

import * as fs from 'fs'
import * as path from 'path'
import { getProvider } from '../llm/provider-factory'
import type { PitchDeckExtractionResult } from '../../shared/types/pitch-deck'
import type { ChatAttachment } from '../../shared/types/chat'

export async function runPitchDeckAnalysis(
  extractionResult: PitchDeckExtractionResult
): Promise<string | null> {
  // Build attachment for vision PDFs (rawText is '' when pdf-parse found no text)
  let attachments: ChatAttachment[] | undefined

  if (!extractionResult.rawText) {
    if (!extractionResult.sourceFilePath) {
      console.warn('[pitch-deck-analysis] no rawText or sourceFilePath, skipping analysis')
      return null
    }
    // Vision PDF: re-read the original file from disk for the VC analysis LLM call
    try {
      const pdfBuffer = fs.readFileSync(extractionResult.sourceFilePath)
      attachments = [{
        name: path.basename(extractionResult.sourceFilePath),
        mimeType: 'application/pdf',
        type: 'pdf',
        data: pdfBuffer.toString('base64'),
      }]
    } catch (err) {
      console.warn('[pitch-deck-analysis] could not re-read PDF for analysis', {
        sourceFilePath: extractionResult.sourceFilePath,
        err,
      })
      return null
    }
  }

  const systemPrompt = [
    'You are an expert venture capital analyst.',
    'Analyze the following pitch deck content and produce a two-part response.',
    'Part 1: A "Partner Sync Summary" section with specific structured fields.',
    'Part 2: A full investment analysis with 8 standard VC sections.',
    'Keep summaries concise — bullet points rather than full paragraphs.',
  ].join(' ')

  const companyLabel = extractionResult.companyName ?? extractionResult.sourceLabel ?? 'Unknown'
  const hasText = !!extractionResult.rawText

  const userPrompt = [
    'Analyze this pitch deck and produce TWO sections separated by ---',
    '',
    'SECTION 1 — start with exactly this heading:',
    '## Partner Sync Summary',
    '',
    'Include ONLY the following lines, and ONLY if the information is available in the deck.',
    'Omit any line where the information is absent:',
    `Company: ${companyLabel}`,
    'Founder: [name] — [1-sentence bio including where they previously worked]; [LinkedIn URL if found in deck]',
    'Company Description: [1 sentence]',
    'Round: [how much raising and at what valuation]',
    'Location: [City, ST]',
    'Key Metrics & Traction: [1 sentence — ACV, design partners vs long-term agreements, growth, key progress]',
    'Website: [URL]',
    '',
    '---',
    '',
    'SECTION 2 — start with exactly this heading:',
    '## Full Analysis',
    '',
    'Provide structured analysis with these sections:',
    '1. **Company Overview** - What the company does, stage, and sector',
    '2. **Key Metrics & Traction** - Revenue, growth, users, retention, ACV',
    '3. **Team** - Founders and key team backgrounds',
    '4. **Market Opportunity** - TAM/SAM/SOM, competitive landscape',
    '5. **The Ask** - Funding amount, valuation, use of proceeds',
    '6. **Strengths** - What is compelling about this opportunity',
    '7. **Concerns & Follow-ups** - Red flags, open questions, due diligence items',
    '8. **Action Items** - Next steps',
    '',
    ...(hasText
      ? ['## Pitch Deck Content:', extractionResult.rawText ?? '']
      : ['(The pitch deck is provided as an attached PDF document.)']),
  ].join('\n')

  console.log('[pitch-deck-analysis] calling LLM', {
    hasRawText: hasText,
    rawTextLength: extractionResult.rawText?.length ?? 0,
    hasSourceFilePath: !!extractionResult.sourceFilePath,
    hasPdfAttachment: !!attachments,
    companyLabel,
  })

  try {
    const raw = await getProvider('enrichment').generateSummary(
      systemPrompt,
      userPrompt,
      undefined,   // onProgress
      undefined,   // signal
      attachments, // ChatAttachment[] | undefined
    )
    if (!raw || raw.trim().length < 10) {
      console.warn('[pitch-deck-analysis] LLM returned empty/short response', { companyLabel })
      return null
    }
    console.log('[pitch-deck-analysis] LLM response received', { length: raw.length, companyLabel })
    return raw.trim()
  } catch (err) {
    console.error('[pitch-deck-analysis] LLM call failed:', err)
    return null
  }
}
