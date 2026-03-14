import { BrowserWindow } from 'electron'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { getMemosDir } from '../storage/paths'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeFilePart(value: string): string {
  return value
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function applyInlineFormatting(escaped: string): string {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
}

export interface MemoHeaderParams {
  logoDataUrl?: string | null
  title: string
  date: string
}

function buildHeaderHtml(header: MemoHeaderParams): string {
  const logoCell = header.logoDataUrl
    ? `<td style="width:80px;vertical-align:middle;padding:0 16px 0 0;">
        <img src="${header.logoDataUrl}" style="width:72px;height:72px;object-fit:contain;" />
      </td>`
    : ''
  const titleCell = `<td style="vertical-align:middle;text-align:${header.logoDataUrl ? 'center' : 'left'};padding:0;">
      <div style="font-size:17px;font-weight:700;color:#111827;">${escapeHtml(header.title)}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px;">${escapeHtml(header.date)}</div>
    </td>`
  return `<table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
    <tr>${logoCell}${titleCell}</tr>
  </table>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin-bottom:24px;" />`
}

export function buildMemoDocTitle(
  companyName: string,
  companyDetails?: {
    round?: string | null
    raiseSize?: number | null
    postMoneyValuation?: number | null
  }
): string {
  if (!companyDetails?.round && !companyDetails?.raiseSize && !companyDetails?.postMoneyValuation) {
    return companyName
  }
  const parts: string[] = []
  if (companyDetails?.raiseSize) {
    const raise = (companyDetails.raiseSize / 1_000_000).toFixed(1).replace(/\.0$/, '')
    parts.push(`$${raise}M Investment`)
  }
  if (companyDetails?.postMoneyValuation) {
    const val = (companyDetails.postMoneyValuation / 1_000_000).toFixed(1).replace(/\.0$/, '')
    const roundStr = companyDetails?.round ? ` ${companyDetails.round}` : ''
    parts.push(`$${val}M Post Money${roundStr}`)
  } else if (companyDetails?.round) {
    parts.push(companyDetails.round)
  }
  return parts.length > 0 ? `${companyName} - ${parts.join(' in ')}` : companyName
}

function formatMonthYear(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export function markdownToHtml(markdown: string, header?: MemoHeaderParams): string {
  const lines = markdown.split('\n')
  const output: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      output.push('<div style="height:8px"></div>')
      continue
    }

    if (trimmed.startsWith('### ')) {
      output.push(`<h3>${applyInlineFormatting(escapeHtml(trimmed.slice(4)))}</h3>`)
      continue
    }
    if (trimmed.startsWith('## ')) {
      output.push(`<h2>${applyInlineFormatting(escapeHtml(trimmed.slice(3)))}</h2>`)
      continue
    }
    if (trimmed.startsWith('# ')) {
      output.push(`<h1>${applyInlineFormatting(escapeHtml(trimmed.slice(2)))}</h1>`)
      continue
    }
    if (trimmed.startsWith('- ')) {
      output.push(`<li>${applyInlineFormatting(escapeHtml(trimmed.slice(2)))}</li>`)
      continue
    }

    output.push(`<p>${applyInlineFormatting(escapeHtml(trimmed))}</p>`)
  }

  const collapsed = output
    .join('\n')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/<\/ul>\s*<ul>/g, '')

  const headerHtml = header ? buildHeaderHtml(header) : ''

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: #111827;
            margin: 40px;
            line-height: 1.5;
            font-size: 13px;
          }
          h1 { font-size: 24px; margin: 0 0 10px 0; }
          h2 { font-size: 18px; margin: 18px 0 8px; }
          h3 { font-size: 15px; margin: 16px 0 6px; }
          p { margin: 6px 0; }
          ul { margin: 8px 0 8px 20px; }
          li { margin: 4px 0; }
        </style>
      </head>
      <body>${headerHtml}${collapsed}</body>
    </html>
  `
}

export async function exportMemoMarkdownToPdf(params: {
  companyName: string
  memoTitle: string
  versionNumber: number
  contentMarkdown: string
  logoDataUrl?: string | null
  companyDetails?: {
    round?: string | null
    raiseSize?: number | null
    postMoneyValuation?: number | null
  }
}): Promise<{ absolutePath: string; filename: string }> {
  const safeCompany = sanitizeFilePart(params.companyName || 'Company')
  const safeTitle = sanitizeFilePart(params.memoTitle || 'Investment Memo')
  const filename = `${safeCompany} - ${safeTitle} - v${params.versionNumber}.pdf`
  const absolutePath = join(getMemosDir(), filename)

  const header: MemoHeaderParams | undefined = params.logoDataUrl
    ? {
        logoDataUrl: params.logoDataUrl,
        title: buildMemoDocTitle(params.companyName, params.companyDetails),
        date: formatMonthYear(new Date())
      }
    : undefined

  const html = markdownToHtml(params.contentMarkdown, header)

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 1600,
    webPreferences: {
      sandbox: true
    }
  })

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
    })
    writeFileSync(absolutePath, pdf)
    return { absolutePath, filename }
  } finally {
    win.destroy()
  }
}
