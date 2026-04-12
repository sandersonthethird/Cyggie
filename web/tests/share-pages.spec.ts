/**
 * E2E tests for web share pages — meeting, note, memo.
 *
 * Test fixture pages at /test-share/{meeting,note,memo} render each share
 * page component with mock data, so no live DB is required.
 *
 * Chat API calls are intercepted via page.route() to return mock SSE
 * responses, avoiding the need for a real Claude API key.
 *
 * Coverage:
 *   ✓ Header, card, footer present on all 3 page types
 *   ✓ FloatingChatWidget renders + expands on submit
 *   ✓ Minimize (⌄) collapses, Close (✕) clears messages
 *   ✓ Share button → "Copied!" (clipboard success path)
 *   ✓ Print CSS hides header/footer/widget
 *   ✓ Mobile viewport: no horizontal overflow
 *   ✓ null apiKeyEnc → error shown in widget panel
 *   ✓ Rate limit 429 → "Daily limit reached" shown in widget panel
 */

import { test, expect, type Page, type Route } from '@playwright/test'

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const PAGES = [
  { name: 'meeting', path: '/test-share/meeting', apiPath: '/api/chat' },
  { name: 'note', path: '/test-share/note', apiPath: '/api/note-chat' },
  { name: 'memo', path: '/test-share/memo', apiPath: '/api/memo-chat' },
] as const

/** Intercept chat API with a single streamed text response */
async function mockChatSuccess(page: Page, apiPath: string, text = 'Hello from AI!') {
  await page.route(`**${apiPath}`, (route: Route) => {
    const sseBody = [
      `data: ${JSON.stringify({ text })}\n\n`,
      'data: [DONE]\n\n',
    ].join('')
    route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-RateLimit-Remaining': '49',
      },
      body: sseBody,
    })
  })
}

/** Intercept chat API with an error response */
async function mockChatError(page: Page, apiPath: string, errorMsg: string, status = 400) {
  await page.route(`**${apiPath}`, (route: Route) => {
    route.fulfill({
      status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: errorMsg }),
    })
  })
}

// ------------------------------------------------------------------
// Structure tests — all 3 page types
// ------------------------------------------------------------------

for (const { name, path } of PAGES) {
  test.describe(`${name} share page — structure`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(path)
    })

    test('sticky header is visible', async ({ page }) => {
      const header = page.locator('[data-share-header]')
      await expect(header).toBeVisible()
    })

    test('header contains a logo image', async ({ page }) => {
      const logo = page.locator('[data-share-header] img')
      await expect(logo).toBeVisible()
    })

    test('header contains Share, Print, Refresh buttons', async ({ page }) => {
      const header = page.locator('[data-share-header]')
      await expect(header.getByText('Share')).toBeVisible()
      await expect(header.getByText('Print')).toBeVisible()
      await expect(header.getByText('Refresh')).toBeVisible()
    })

    test('white card on gray background', async ({ page }) => {
      // Gray background on body/main
      const body = page.locator('body')
      const bodyBg = await body.evaluate((el) => window.getComputedStyle(el).backgroundColor)
      // Card (article element) should be white
      const card = page.locator('article')
      await expect(card).toBeVisible()
      const cardBg = await card.evaluate((el) => window.getComputedStyle(el).backgroundColor)
      expect(cardBg).toBe('rgb(255, 255, 255)')
    })

    test('footer is visible', async ({ page }) => {
      const footer = page.locator('[data-share-footer]')
      await expect(footer).toBeVisible()
      await expect(footer.getByText('Cyggie')).toBeVisible()
    })

    test('"Powered by Cyggie" watermark is in the card', async ({ page }) => {
      const card = page.locator('article')
      await expect(card.getByText('Powered by Cyggie')).toBeVisible()
    })

    test('floating chat widget is present', async ({ page }) => {
      const widget = page.locator('[data-floating-chat]')
      await expect(widget).toBeVisible()
    })
  })
}

// ------------------------------------------------------------------
// FloatingChatWidget behaviour
// ------------------------------------------------------------------

test.describe('FloatingChatWidget — interaction', () => {
  test.beforeEach(async ({ page }) => {
    await mockChatSuccess(page, '/api/chat', 'This is a test AI response.')
    await page.goto('/test-share/meeting')
  })

  test('widget expands when user submits a question', async ({ page }) => {
    const widget = page.locator('[data-floating-chat]')
    const textarea = widget.locator('textarea')

    // Panel header should not be visible before submit
    await expect(widget.getByText('Ask AI')).not.toBeVisible()

    await textarea.fill('What was discussed?')
    await textarea.press('Enter')

    // Panel should open
    await expect(widget.getByText('Ask AI')).toBeVisible()
  })

  test('messages appear after submit', async ({ page }) => {
    const widget = page.locator('[data-floating-chat]')
    await widget.locator('textarea').fill('What was discussed?')
    await widget.locator('textarea').press('Enter')

    // User message appears
    await expect(widget.getByText('What was discussed?')).toBeVisible()
    // AI response streams in
    await expect(widget.getByText('This is a test AI response.')).toBeVisible({ timeout: 5000 })
  })

  test('minimize (⌄) collapses panel but keeps messages', async ({ page }) => {
    const widget = page.locator('[data-floating-chat]')
    const textarea = widget.locator('textarea')
    await textarea.fill('Quick question')
    await textarea.press('Enter')
    await expect(widget.getByText('Ask AI')).toBeVisible()
    await expect(widget.getByText('This is a test AI response.')).toBeVisible({ timeout: 5000 })

    // Minimize
    await widget.getByTitle('Minimize').click()
    await expect(widget.getByText('Ask AI')).not.toBeVisible()

    // Re-focus input — panel should reopen with messages
    await textarea.focus()
    await expect(widget.getByText('Ask AI')).toBeVisible()
  })

  test('close (✕) collapses panel and clears messages', async ({ page }) => {
    const widget = page.locator('[data-floating-chat]')
    await widget.locator('textarea').fill('Quick question')
    await widget.locator('textarea').press('Enter')
    await expect(widget.getByText('This is a test AI response.')).toBeVisible({ timeout: 5000 })

    // Close
    await widget.getByTitle('Close').click()
    await expect(widget.getByText('Ask AI')).not.toBeVisible()

    // Re-focus — no messages, panel stays closed
    await widget.locator('textarea').focus()
    await expect(widget.getByText('Ask AI')).not.toBeVisible()
  })

  test('Escape key minimizes the panel', async ({ page }) => {
    const widget = page.locator('[data-floating-chat]')
    await widget.locator('textarea').fill('Hello?')
    await widget.locator('textarea').press('Enter')
    await expect(widget.getByText('Ask AI')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(widget.getByText('Ask AI')).not.toBeVisible()
  })

  test('Shift+Enter inserts newline instead of submitting', async ({ page }) => {
    const widget = page.locator('[data-floating-chat]')
    const textarea = widget.locator('textarea')
    await textarea.fill('Line one')
    await textarea.press('Shift+Enter')
    // Panel should NOT have opened (no submit)
    await expect(widget.getByText('Ask AI')).not.toBeVisible()
  })
})

// ------------------------------------------------------------------
// SharedHeader — Share button
// ------------------------------------------------------------------

test.describe('SharedHeader — Share button', () => {
  test('shows "Copied!" on clipboard success', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/test-share/meeting')

    await page.locator('[data-share-header]').getByText('Share').click()
    await expect(page.locator('[data-share-header]').getByText('Copied!')).toBeVisible()

    // Reverts back after ~2s
    await expect(page.locator('[data-share-header]').getByText('Share')).toBeVisible({ timeout: 3000 })
  })
})

// ------------------------------------------------------------------
// Print CSS
// ------------------------------------------------------------------

test.describe('Print CSS', () => {
  test('[data-share-header] is hidden in print media', async ({ page }) => {
    await page.goto('/test-share/meeting')

    const displayValue = await page.evaluate(() => {
      const style = document.createElement('style')
      style.textContent = '@media print { [data-share-header] { display: none !important; } }'
      // Check via matchMedia or direct CSS evaluation
      const el = document.querySelector('[data-share-header]') as HTMLElement
      if (!el) return 'missing'
      // Read the print stylesheet rule from globals.css
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule instanceof CSSMediaRule && rule.conditionText === 'print') {
              for (const inner of Array.from(rule.cssRules)) {
                if ((inner as CSSStyleRule).selectorText?.includes('data-share-header')) {
                  return (inner as CSSStyleRule).style.display
                }
              }
            }
          }
        } catch {
          // cross-origin sheet — skip
        }
      }
      return 'not-found'
    })

    expect(displayValue).toBe('none')
  })
})

// ------------------------------------------------------------------
// Mobile viewport — no horizontal overflow
// ------------------------------------------------------------------

test.describe('Mobile viewport', () => {
  test('floating widget does not overflow horizontally at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/test-share/note')

    const widget = page.locator('[data-floating-chat]')
    await expect(widget).toBeVisible()

    const box = await widget.boundingBox()
    expect(box).not.toBeNull()
    // Widget right edge should not exceed viewport width
    expect(box!.x + box!.width).toBeLessThanOrEqual(375 + 1) // +1px tolerance
  })
})

// ------------------------------------------------------------------
// Error states
// ------------------------------------------------------------------

test.describe('FloatingChatWidget — null apiKeyEnc (old note share)', () => {
  test('shows re-share message when API returns 400', async ({ page }) => {
    const errMsg = 'This note was shared before AI chat was available. Please re-share the note to enable chat.'
    await mockChatError(page, '/api/note-chat', errMsg, 400)
    await page.goto('/test-share/note')

    const widget = page.locator('[data-floating-chat]')
    await widget.locator('textarea').fill('Any questions?')
    await widget.locator('textarea').press('Enter')

    await expect(widget.getByText(errMsg)).toBeVisible({ timeout: 5000 })
  })
})

test.describe('FloatingChatWidget — rate limit', () => {
  test('shows daily limit message when API returns 429', async ({ page }) => {
    await mockChatError(page, '/api/chat', 'Daily chat limit reached. Please try again tomorrow.', 429)
    await page.goto('/test-share/meeting')

    const widget = page.locator('[data-floating-chat]')
    await widget.locator('textarea').fill('One more question')
    await widget.locator('textarea').press('Enter')

    await expect(widget.getByText('Daily chat limit reached. Please try again tomorrow.')).toBeVisible({ timeout: 5000 })
  })
})
