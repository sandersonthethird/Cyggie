import { createHash, randomUUID } from 'crypto'
import * as taskRepo from '@cyggie/db/sqlite/repositories/task.repo'
import type { TaskCategory, TaskExtractionResult, ProposedTask } from '@shared/types/task'

const ACTION_ITEM_LABELS = ['action items', 'next steps', 'follow-ups', 'follow ups', 'action items & next steps']
const COMMITMENT_LABELS = ['commitments', 'commitments made']

// Hard cap on how many tasks we ever propose from a single meeting. The LLM
// prompt asks for a small number of action items, but it's unreliable, so
// without a cap a busy meeting can yield 15-20 proposals. Keep only the most
// actionable few.
const MAX_PROPOSED_TASKS = 5

// Category priority when trimming to MAX_PROPOSED_TASKS: actionable work first,
// then commitments. Decisions are never auto-extracted (they're records, not
// tasks), so they don't appear here.
const CATEGORY_PRIORITY: Record<TaskCategory, number> = {
  action_item: 0,
  follow_up: 1,
  decision: 2
}

// Extended set of section header hints (superset of company-summary-sync)
const SECTION_HEADER_HINTS = [
  'executive summary', 'company overview', 'key metrics', 'traction',
  'team', 'market opportunity', 'the ask', 'ask', 'strengths',
  'concerns', 'follow-ups', 'follow ups', 'action items', 'next steps',
  'decisions', 'decisions made', 'key decisions', 'commitments',
  'commitments made', 'overall assessment', 'progress update',
  'questions asked', 'concerns raised', 'agenda items', 'key points',
  'fund updates', 'hiring', 'support needed', 'challenges',
  'dissenting views', 'deal discussion', 'attendees'
]

interface ExtractedItem {
  text: string
  assignee: string | null
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[\).]\s+/, '')
    .trim()
}

function normalizeHeaderLine(value: string): string {
  const plain = stripMarkdown(value)
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\d+[\).\s-]+/, '')
    .trim()
    .toLowerCase()
  return normalizeWhitespace(plain)
}

function isLikelySectionHeader(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^#{1,6}\s+/.test(trimmed)) return true
  const normalized = normalizeHeaderLine(trimmed)
  if (!normalized) return false
  return SECTION_HEADER_HINTS.some((hint) => normalized.startsWith(hint))
}

function computeHash(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex').slice(0, 32)
}

function extractAssignee(text: string): { cleaned: string; assignee: string | null } {
  // Pattern: "do something (Owner: Name)" or "(assigned to Name)"
  const parenPattern = /\((?:owner|assigned to|assignee)[:\s]+([^)]+)\)/i
  const parenMatch = text.match(parenPattern)
  if (parenMatch) {
    return {
      cleaned: text.replace(parenPattern, '').trim(),
      assignee: parenMatch[1].trim()
    }
  }

  // Pattern: "do something @Name"
  const atPattern = /@([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/
  const atMatch = text.match(atPattern)
  if (atMatch) {
    return {
      cleaned: text.replace(atPattern, '').trim(),
      assignee: atMatch[1].trim()
    }
  }

  // Pattern: "Name: do something" or "Name - do something"
  const colonPattern = /^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*[:–—-]\s+(.+)/
  const colonMatch = text.match(colonPattern)
  if (colonMatch && colonMatch[2].length > 10) {
    return {
      cleaned: colonMatch[2].trim(),
      assignee: colonMatch[1].trim()
    }
  }

  return { cleaned: text, assignee: null }
}

/**
 * Extracts individual bullet items from a markdown section identified by the given labels.
 * Unlike the company-summary-sync extractSection() which concatenates all lines,
 * this splits into individual list items.
 */
function extractSectionItems(summary: string, labels: string[]): ExtractedItem[] {
  const normalizedLabels = labels.map((l) => l.toLowerCase())
  const lines = summary.split(/\r?\n/)
  let startIndex = -1

  // Find the section header
  for (let i = 0; i < lines.length; i += 1) {
    const normalized = normalizeHeaderLine(lines[i])
    if (!normalized) continue
    if (normalizedLabels.some((label) => normalized.startsWith(label))) {
      startIndex = i + 1
      break
    }
  }

  if (startIndex < 0) return []

  // Collect individual bullet items until next section header or end
  const items: ExtractedItem[] = []
  let currentItem = ''

  for (let i = startIndex; i < lines.length; i += 1) {
    const raw = lines[i].trim()

    // Stop at next section header
    if (raw && isLikelySectionHeader(raw) && (items.length > 0 || currentItem)) break

    // Skip empty lines between items
    if (!raw) {
      if (currentItem) {
        const { cleaned, assignee } = extractAssignee(stripMarkdown(currentItem))
        const normalized = normalizeWhitespace(cleaned)
        if (normalized && normalized.length >= 5) {
          items.push({ text: normalized, assignee })
        }
        currentItem = ''
      }
      continue
    }

    // Detect bullet/numbered list item start
    const isBullet = /^[-*+]\s+/.test(raw) || /^\d+[\).]\s+/.test(raw)

    if (isBullet) {
      // Flush previous item
      if (currentItem) {
        const { cleaned, assignee } = extractAssignee(stripMarkdown(currentItem))
        const normalized = normalizeWhitespace(cleaned)
        if (normalized && normalized.length >= 5) {
          items.push({ text: normalized, assignee })
        }
      }
      currentItem = raw
    } else if (currentItem) {
      // Continuation line for current item
      currentItem += ' ' + raw
    } else {
      // Non-bullet content at section start - treat as standalone item
      currentItem = raw
    }
  }

  // Flush last item
  if (currentItem) {
    const { cleaned, assignee } = extractAssignee(stripMarkdown(currentItem))
    const normalized = normalizeWhitespace(cleaned)
    if (normalized && normalized.length >= 5) {
      items.push({ text: normalized, assignee })
    }
  }

  return items
}

export function extractTasksFromSummary(
  meetingId: string,
  summary: string,
  companyId: string | null,
  _userId: string | null
): TaskExtractionResult {
  const proposed: ProposedTask[] = []
  let duplicatesSkipped = 0

  const sectionGroups: Array<{
    labels: string[]
    category: TaskCategory
    sourceSection: string
  }> = [
    { labels: ACTION_ITEM_LABELS, category: 'action_item', sourceSection: 'action_items' },
    { labels: COMMITMENT_LABELS, category: 'follow_up', sourceSection: 'commitments' }
  ]

  for (const group of sectionGroups) {
    const items = extractSectionItems(summary, group.labels)

    for (const item of items) {
      const hash = computeHash(item.text)

      if (taskRepo.existsByMeetingAndHash(meetingId, hash)) {
        duplicatesSkipped++
        continue
      }

      const title = item.text.length > 200 ? item.text.slice(0, 197) + '...' : item.text
      proposed.push({
        key: randomUUID(),
        title,
        description: item.text.length > 200 ? item.text : null,
        meetingId,
        companyId,
        category: group.category,
        assignee: item.assignee,
        sourceSection: group.sourceSection,
        extractionHash: hash
      })
    }
  }

  // Trim to the most important few. Items are extracted in section order, so a
  // stable sort by category priority keeps the relative order within each
  // category while floating action items to the top. Anything beyond the cap is
  // dropped rather than shown — the user asked for a short, high-signal list.
  proposed.sort((a, b) => CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category])
  const capped = proposed.slice(0, MAX_PROPOSED_TASKS)

  return { proposed: capped, duplicatesSkipped }
}
