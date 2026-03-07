#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const crypto = require('crypto')
const { spawn } = require('child_process')
const Database = require('better-sqlite3')
const { google } = require('googleapis')
const pdfParse = require('pdf-parse')

const DEFAULT_INPUT_PATH = path.join('import', 'memos', 'raw')
const DEFAULT_DB_PATH = path.join(os.homedir(), 'Documents', 'MeetingIntelligence', 'echovault.db')
const DEFAULT_TOKEN_PATH = path.join('import', 'memos', '.google-docs-token.json')
const DEFAULT_TEMPLATE_SETTING_KEY = 'memo_default_template_markdown'

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly'
]

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown'])
const PDF_EXTENSION = '.pdf'
const GDOC_EXTENSION = '.gdoc'

function printUsage() {
  console.log('Usage: node scripts/import-memos-from-google-docs.js [input_path] [options]')
  console.log('')
  console.log('Input modes:')
  console.log('  - local folder/file mode: pass a directory (or file) containing memo files')
  console.log('  - csv/google-doc mode: pass a CSV file with name,url columns')
  console.log('')
  console.log('Options:')
  console.log('  --source <auto|local-folder|csv-google-docs>  Force input source mode (default auto)')
  console.log('  --db <path>                    SQLite DB path')
  console.log('  --dry-run                      Parse and match but do not write to DB')
  console.log('  --no-backup                    Skip DB backup before write')
  console.log('  --client-id <id>               Google OAuth client id (CSV mode only)')
  console.log('  --client-secret <secret>       Google OAuth client secret (CSV mode only)')
  console.log('  --oauth-client <json_path>     OAuth client credentials file (CSV mode only)')
  console.log('  --token-file <path>            OAuth token cache path (CSV mode only)')
  console.log('  --no-template-update           Do not update default memo template setting')
  console.log('  --template-setting-key <key>   Setting key for default template')
  console.log('  --create-missing-companies     Create unknown companies when no match is found')
  console.log('  --limit <n>                    Process only first n records')
  console.log('  --no-open-browser              Do not auto-open OAuth URL (CSV mode only)')
  console.log('')
  console.log('Env fallbacks (CSV mode): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET')
}

function parseArgs(argv) {
  const args = argv.slice(2)
  const options = {
    inputPath: DEFAULT_INPUT_PATH,
    source: 'auto',
    dbPath: DEFAULT_DB_PATH,
    dryRun: false,
    backup: true,
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    oauthClientPath: '',
    tokenFile: DEFAULT_TOKEN_PATH,
    updateTemplate: true,
    templateSettingKey: DEFAULT_TEMPLATE_SETTING_KEY,
    createMissingCompanies: false,
    limit: null,
    openBrowser: true
  }

  let positionalConsumed = false
  let i = 0
  while (i < args.length) {
    const token = args[i]

    if (token === '--help' || token === '-h') {
      printUsage()
      process.exit(0)
    }

    if (token === '--source') {
      const next = args[i + 1]
      if (!next) throw new Error('--source requires a value')
      const allowed = new Set(['auto', 'local-folder', 'csv-google-docs'])
      if (!allowed.has(next)) {
        throw new Error(`Invalid --source value: ${next}`)
      }
      options.source = next
      i += 2
      continue
    }

    if (token === '--db') {
      const next = args[i + 1]
      if (!next) throw new Error('--db requires a path')
      options.dbPath = next
      i += 2
      continue
    }

    if (token === '--dry-run') {
      options.dryRun = true
      i += 1
      continue
    }

    if (token === '--no-backup') {
      options.backup = false
      i += 1
      continue
    }

    if (token === '--client-id') {
      const next = args[i + 1]
      if (!next) throw new Error('--client-id requires a value')
      options.clientId = next
      i += 2
      continue
    }

    if (token === '--client-secret') {
      const next = args[i + 1]
      if (!next) throw new Error('--client-secret requires a value')
      options.clientSecret = next
      i += 2
      continue
    }

    if (token === '--oauth-client') {
      const next = args[i + 1]
      if (!next) throw new Error('--oauth-client requires a path')
      options.oauthClientPath = next
      i += 2
      continue
    }

    if (token === '--token-file') {
      const next = args[i + 1]
      if (!next) throw new Error('--token-file requires a path')
      options.tokenFile = next
      i += 2
      continue
    }

    if (token === '--no-template-update') {
      options.updateTemplate = false
      i += 1
      continue
    }

    if (token === '--template-setting-key') {
      const next = args[i + 1]
      if (!next) throw new Error('--template-setting-key requires a value')
      options.templateSettingKey = next
      i += 2
      continue
    }

    if (token === '--create-missing-companies') {
      options.createMissingCompanies = true
      i += 1
      continue
    }

    if (token === '--limit') {
      const next = args[i + 1]
      if (!next) throw new Error('--limit requires a number')
      const parsed = Number(next)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error('--limit must be a positive integer')
      }
      options.limit = parsed
      i += 2
      continue
    }

    if (token === '--no-open-browser') {
      options.openBrowser = false
      i += 1
      continue
    }

    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`)
    }

    if (!positionalConsumed) {
      options.inputPath = token
      positionalConsumed = true
      i += 1
      continue
    }

    throw new Error(`Unexpected argument: ${token}`)
  }

  return options
}

function parseCsv(content) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]

    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      continue
    }

    if (ch === ',') {
      row.push(field)
      field = ''
      continue
    }

    if (ch === '\r') {
      if (content[i + 1] === '\n') continue
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }

    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }

    field += ch
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function cleanDisplayName(value) {
  return String(value || '')
    .trim()
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function normalizeHeading(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s:_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanHeadingLabel(value) {
  return String(value || '')
    .trim()
    .replace(/^#+\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/[\s:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractDocIdFromUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return null
  const match = raw.match(/\/document\/d\/([A-Za-z0-9_-]{20,})/)
  if (match && match[1]) return match[1]
  return null
}

function parseCsvRows(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`)
  }

  const content = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '')
  const rows = parseCsv(content)
  if (rows.length < 2) {
    throw new Error('CSV must include a header row and at least one data row')
  }

  const headers = rows[0].map((value) => String(value || '').trim().toLowerCase())
  const nameIndexCandidates = ['name', 'memo_name', 'title']
  const urlIndexCandidates = ['url', 'memo_url', 'doc_url', 'google_doc_url']

  const nameIndex = nameIndexCandidates
    .map((candidate) => headers.indexOf(candidate))
    .find((idx) => idx >= 0)
  const urlIndex = urlIndexCandidates
    .map((candidate) => headers.indexOf(candidate))
    .find((idx) => idx >= 0)

  if (nameIndex == null || nameIndex < 0) {
    throw new Error('CSV header is missing a memo name column (expected one of: name, memo_name, title)')
  }
  if (urlIndex == null || urlIndex < 0) {
    throw new Error('CSV header is missing a URL column (expected one of: url, memo_url, doc_url, google_doc_url)')
  }

  const records = []
  for (let i = 1; i < rows.length; i += 1) {
    const rawRow = rows[i]
    const memoName = cleanDisplayName(rawRow[nameIndex] || '')
    const url = cleanDisplayName(rawRow[urlIndex] || '')
    if (!memoName && !url) continue
    records.push({
      rowNumber: i + 1,
      memoName,
      sourceType: 'google_doc_csv',
      sourceLabel: url || '(empty url)',
      sourceUrl: url,
      docId: extractDocIdFromUrl(url),
      stemKey: stemKeyFromTitle(memoName)
    })
  }

  return records
}

function listFilesRecursively(rootPath) {
  const files = []
  const stack = [rootPath]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue

    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b))
}

function stripKnownMemoSuffixes(title) {
  return cleanDisplayName(title)
    .replace(/\bred\s+swan\s+investment\s+memo\b/gi, '')
    .replace(/\binvestment\s+memo\b/gi, '')
    .replace(/\binternal\b/gi, '')
    .replace(/\bdraft\b/gi, '')
    .replace(/\bnotes?\b/gi, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[\-:|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stemKeyFromTitle(title) {
  const stripped = stripKnownMemoSuffixes(title)
  const compact = compactName(stripped)
  if (compact) return compact
  return compactName(title)
}

function recordFromLocalFile(filePath, rowNumber, rootPath) {
  const basename = path.basename(filePath)
  const ext = path.extname(basename).toLowerCase()
  const memoName = cleanDisplayName(path.basename(basename, ext))
  const relativePath = path.relative(rootPath, filePath) || basename

  if (ext === GDOC_EXTENSION) {
    return {
      rowNumber,
      memoName,
      sourceType: 'local_gdoc',
      sourceLabel: relativePath,
      sourcePath: filePath,
      stemKey: stemKeyFromTitle(memoName)
    }
  }

  if (ext === PDF_EXTENSION) {
    return {
      rowNumber,
      memoName,
      sourceType: 'local_pdf',
      sourceLabel: relativePath,
      sourcePath: filePath,
      stemKey: stemKeyFromTitle(memoName)
    }
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    return {
      rowNumber,
      memoName,
      sourceType: 'local_text',
      sourceLabel: relativePath,
      sourcePath: filePath,
      stemKey: stemKeyFromTitle(memoName)
    }
  }

  return null
}

function parseLocalInputRecords(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input path not found: ${inputPath}`)
  }

  const stat = fs.statSync(inputPath)
  let files = []
  let rootPath = inputPath

  if (stat.isDirectory()) {
    files = listFilesRecursively(inputPath)
  } else if (stat.isFile()) {
    files = [inputPath]
    rootPath = path.dirname(inputPath)
  } else {
    throw new Error(`Unsupported input path type: ${inputPath}`)
  }

  const records = []
  let rowNumber = 1
  for (const filePath of files) {
    const record = recordFromLocalFile(filePath, rowNumber, rootPath)
    rowNumber += 1
    if (record) {
      records.push(record)
    }
  }

  return records
}

function resolveSourceMode(inputPath, requestedSource) {
  if (requestedSource && requestedSource !== 'auto') {
    return requestedSource
  }

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input path not found: ${inputPath}`)
  }

  const stat = fs.statSync(inputPath)
  if (stat.isDirectory()) {
    return 'local-folder'
  }

  if (stat.isFile()) {
    const ext = path.extname(inputPath).toLowerCase()
    if (ext === '.csv') return 'csv-google-docs'
    return 'local-folder'
  }

  return 'local-folder'
}

function extractCompanyCandidates(memoTitle) {
  const title = cleanDisplayName(memoTitle)
  if (!title) return []

  const candidates = []

  const patternA = title.match(/^investment\s+memo\s*[:\-]\s*(.+)$/i)
  if (patternA && patternA[1]) {
    candidates.push(patternA[1])
  }

  const patternB = title.match(/^(.+?)\s*[-:|]\s*investment\s+memo\b/i)
  if (patternB && patternB[1]) {
    candidates.push(patternB[1])
  }

  candidates.push(stripKnownMemoSuffixes(title))
  candidates.push(title)

  const cleaned = []
  const seen = new Set()
  for (const candidateRaw of candidates) {
    const candidate = cleanDisplayName(candidateRaw)
      .replace(/\s*\((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[^)]*\)$/i, '')
      .replace(/\s*\((?:q[1-4]|\d{1,2}\/\d{2,4}|\d{4})[^)]*\)$/i, '')
      .replace(/^[\-:|\s]+|[\-:|\s]+$/g, '')
    const normalized = normalizeName(candidate)
    if (!normalized) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    cleaned.push(candidate)
  }

  return cleaned
}

function tokenizeName(value) {
  return normalizeName(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
}

function levenshteinDistance(left, right) {
  const a = String(left || '')
  const b = String(right || '')
  const m = a.length
  const n = b.length

  if (m === 0) return n
  if (n === 0) return m

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i += 1) dp[i][0] = i
  for (let j = 0; j <= n; j += 1) dp[0][j] = j

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      )
    }
  }

  return dp[m][n]
}

function loadCompanyMatcher(db) {
  const companies = db.prepare('SELECT id, canonical_name, normalized_name FROM org_companies').all()

  const aliasRows = db
    .prepare("SELECT company_id, alias_value FROM org_company_aliases WHERE alias_type = 'name'")
    .all()

  const normalizedMap = new Map()
  const compactMap = new Map()

  for (const company of companies) {
    const normalized = normalizeName(company.normalized_name || company.canonical_name)
    const compact = compactName(company.canonical_name)
    if (normalized && !normalizedMap.has(normalized)) {
      normalizedMap.set(normalized, company)
    }
    if (compact && !compactMap.has(compact)) {
      compactMap.set(compact, company)
    }
  }

  for (const row of aliasRows) {
    const aliasNormalized = normalizeName(row.alias_value)
    if (!aliasNormalized || normalizedMap.has(aliasNormalized)) continue
    const company = companies.find((candidate) => candidate.id === row.company_id)
    if (company) normalizedMap.set(aliasNormalized, company)
  }

  return function matchCompany(memoTitle) {
    const candidates = extractCompanyCandidates(memoTitle)

    for (const candidate of candidates) {
      const normalized = normalizeName(candidate)
      if (normalizedMap.has(normalized)) {
        return {
          company: normalizedMap.get(normalized),
          matchedBy: 'exact',
          matchedText: candidate
        }
      }
    }

    for (const candidate of candidates) {
      const compact = compactName(candidate)
      if (compact && compactMap.has(compact)) {
        return {
          company: compactMap.get(compact),
          matchedBy: 'compact',
          matchedText: candidate
        }
      }
    }

    let best = null
    for (const candidate of candidates) {
      const candidateCompact = compactName(candidate)
      const candidateTokens = tokenizeName(candidate)
      if (!candidateCompact) continue

      for (const company of companies) {
        const companyCompact = compactName(company.canonical_name)
        if (!companyCompact) continue

        let score = 0

        if (candidateCompact.includes(companyCompact) || companyCompact.includes(candidateCompact)) {
          score += 5
        }

        const distance = levenshteinDistance(candidateCompact, companyCompact)
        const maxLen = Math.max(candidateCompact.length, companyCompact.length)
        if (maxLen >= 6 && distance <= 2) {
          score += 4
        }

        const companyTokens = tokenizeName(company.canonical_name)
        const overlap = candidateTokens.filter((token) => companyTokens.includes(token)).length
        score += overlap

        if (!best || score > best.score) {
          best = { company, score, matchedText: candidate }
        }
      }
    }

    if (best && best.score >= 4) {
      return {
        company: best.company,
        matchedBy: 'fuzzy',
        matchedText: best.matchedText
      }
    }

    return null
  }
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr !== 'object') {
        server.close(() => reject(new Error('Could not allocate OAuth callback port')))
        return
      }
      const port = addr.port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function openUrlInBrowser(url) {
  const platform = process.platform
  let command
  let args

  if (platform === 'darwin') {
    command = 'open'
    args = [url]
  } else if (platform === 'win32') {
    command = 'cmd'
    args = ['/c', 'start', '', url]
  } else {
    command = 'xdg-open'
    args = [url]
  }

  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

function loadOAuthClientConfig(options) {
  if (options.oauthClientPath) {
    if (!fs.existsSync(options.oauthClientPath)) {
      throw new Error(`OAuth client file not found: ${options.oauthClientPath}`)
    }

    const raw = fs.readFileSync(options.oauthClientPath, 'utf8')
    const parsed = JSON.parse(raw)
    const source = parsed.installed || parsed.web || parsed

    const clientId = source.client_id || source.clientId || options.clientId
    const clientSecret = source.client_secret || source.clientSecret || options.clientSecret

    return {
      clientId: String(clientId || ''),
      clientSecret: String(clientSecret || '')
    }
  }

  return {
    clientId: String(options.clientId || ''),
    clientSecret: String(options.clientSecret || '')
  }
}

async function authorizeGoogle(options) {
  const { clientId, clientSecret } = loadOAuthClientConfig(options)

  if (!clientId) {
    throw new Error('Google client id is required. Pass --client-id or --oauth-client, or set GOOGLE_CLIENT_ID.')
  }

  const tokenPath = path.resolve(options.tokenFile)
  const tokenDir = path.dirname(tokenPath)
  if (!fs.existsSync(tokenDir)) {
    fs.mkdirSync(tokenDir, { recursive: true })
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret || undefined)

  if (fs.existsSync(tokenPath)) {
    try {
      const tokenJson = JSON.parse(fs.readFileSync(tokenPath, 'utf8'))
      oauth2Client.setCredentials(tokenJson)
      await oauth2Client.getAccessToken()
      return oauth2Client
    } catch (error) {
      console.warn(`[Memo Import] Existing token file invalid/expired; re-authorizing: ${error.message}`)
    }
  }

  const port = await findAvailablePort()
  const redirectUri = `http://127.0.0.1:${port}`
  const client = new google.auth.OAuth2(clientId, clientSecret || undefined, redirectUri)

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES
  })

  console.log('')
  console.log('[Memo Import] Authorize Google access to read memo docs:')
  console.log(authUrl)

  if (options.openBrowser) {
    const opened = openUrlInBrowser(authUrl)
    if (!opened) {
      console.log('[Memo Import] Could not auto-open browser. Paste URL manually.')
    }
  }

  const tokens = await new Promise((resolve, reject) => {
    let server = null
    const timeout = setTimeout(() => {
      if (server) server.close()
      reject(new Error('OAuth authorization timed out after 5 minutes'))
    }, 5 * 60 * 1000)

    server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', redirectUri)
        const error = requestUrl.searchParams.get('error')
        const code = requestUrl.searchParams.get('code')

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end(`Authorization failed: ${error}. You can close this tab.`)
          clearTimeout(timeout)
          server.close()
          reject(new Error(`OAuth error: ${error}`))
          return
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('No authorization code received. You can close this tab.')
          return
        }

        const tokenResponse = await client.getToken(code)
        const tokenData = tokenResponse.tokens

        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('Authorization complete. You can return to the terminal.')

        clearTimeout(timeout)
        server.close()
        resolve(tokenData)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Authorization failed. You can close this tab.')
        clearTimeout(timeout)
        server.close()
        reject(err)
      }
    })

    server.listen(port, '127.0.0.1')
  })

  client.setCredentials(tokens)
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), 'utf8')
  return client
}

function bufferToString(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8')
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')
  }
  return String(value || '')
}

async function fetchGoogleDocContent(authClient, docId) {
  const endpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}/export`
  const mimeTypes = ['text/markdown', 'text/plain']

  for (const mimeType of mimeTypes) {
    try {
      const response = await authClient.request({
        url: endpoint,
        method: 'GET',
        params: { mimeType },
        responseType: 'arraybuffer'
      })

      const text = bufferToString(response.data).replace(/\u0000/g, '').trim()
      if (text) {
        return {
          contentMarkdown: text,
          sourceMeta: {
            sourceKind: 'google_doc_export',
            sourceExportFormat: mimeType,
            templateEligible: true
          }
        }
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      if (mimeType === mimeTypes[mimeTypes.length - 1]) {
        throw new Error(`Failed to export Google Doc ${docId}: ${message}`)
      }
    }
  }

  throw new Error(`Google Doc ${docId} returned empty content`)
}

async function extractPdfText(localPath) {
  const buffer = fs.readFileSync(localPath)
  const parsed = await pdfParse(buffer)
  return String(parsed.text || '')
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseGdocPointer(localPath) {
  try {
    const raw = fs.readFileSync(localPath, 'utf8')
    const parsed = JSON.parse(raw)
    const docId = String(parsed.doc_id || '').trim() || null
    const resourceKey = String(parsed.resource_key || '').trim() || null
    const email = String(parsed.email || '').trim() || null
    return {
      docId,
      resourceKey,
      email
    }
  } catch {
    return {
      docId: null,
      resourceKey: null,
      email: null
    }
  }
}

function buildLocalContentIndex(records) {
  const byStem = new Map()
  for (const record of records) {
    if (record.sourceType !== 'local_pdf' && record.sourceType !== 'local_text') continue
    if (!record.stemKey) continue
    if (!byStem.has(record.stemKey)) {
      byStem.set(record.stemKey, [])
    }
    byStem.get(record.stemKey).push(record)
  }
  return byStem
}

async function getContentForRecord(record, context) {
  if (record.sourceType === 'google_doc_csv') {
    if (!record.docId) {
      return {
        skipReason: 'missing_doc_id'
      }
    }
    const fetched = await fetchGoogleDocContent(context.googleAuthClient, record.docId)
    return {
      contentMarkdown: fetched.contentMarkdown,
      sourceMeta: {
        ...fetched.sourceMeta,
        sourceUrl: record.sourceUrl,
        sourceDocId: record.docId
      }
    }
  }

  if (record.sourceType === 'local_text') {
    const contentMarkdown = fs.readFileSync(record.sourcePath, 'utf8').trim()
    if (!contentMarkdown) {
      return {
        skipReason: 'empty_content'
      }
    }
    return {
      contentMarkdown,
      sourceMeta: {
        sourceKind: 'local_text_file',
        sourcePath: record.sourcePath,
        templateEligible: true
      }
    }
  }

  if (record.sourceType === 'local_pdf') {
    const contentMarkdown = await extractPdfText(record.sourcePath)
    if (!contentMarkdown) {
      return {
        skipReason: 'empty_pdf_text'
      }
    }
    return {
      contentMarkdown,
      sourceMeta: {
        sourceKind: 'local_pdf_file',
        sourcePath: record.sourcePath,
        templateEligible: true
      }
    }
  }

  if (record.sourceType === 'local_gdoc') {
    const pointer = parseGdocPointer(record.sourcePath)
    const linkedContentRecords = context.localContentByStem.get(record.stemKey) || []

    if (linkedContentRecords.length > 0) {
      const linked = linkedContentRecords[0]
      const linkedResult = await getContentForRecord(linked, context)
      if (linkedResult.contentMarkdown) {
        return {
          contentMarkdown: linkedResult.contentMarkdown,
          sourceMeta: {
            ...(linkedResult.sourceMeta || {}),
            sourceKind: 'local_gdoc_with_linked_content',
            sourcePath: record.sourcePath,
            sourceDocId: pointer.docId,
            sourceDocUrl: pointer.docId
              ? `https://docs.google.com/document/d/${pointer.docId}/edit`
              : null,
            linkedSourcePath: linked.sourcePath,
            templateEligible: linkedResult.sourceMeta?.templateEligible === true
          }
        }
      }
    }

    return {
      skipReason: 'gdoc_pointer_without_local_content',
      sourceMeta: {
        sourceKind: 'local_gdoc_pointer',
        sourcePath: record.sourcePath,
        sourceDocId: pointer.docId,
        sourceDocUrl: pointer.docId
          ? `https://docs.google.com/document/d/${pointer.docId}/edit`
          : null,
        pointerEmail: pointer.email
      }
    }
  }

  return {
    skipReason: 'unsupported_source_type'
  }
}

function hashContent(content) {
  return crypto
    .createHash('sha256')
    .update(String(content || '').replace(/\r\n/g, '\n').trim())
    .digest('hex')
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function extractTemplateHeadings(markdown) {
  const lines = String(markdown || '').split(/\r?\n/)
  const headings = []
  const seen = new Set()

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let heading = null

    const markdownMatch = trimmed.match(/^#{1,6}\s+(.+)$/)
    if (markdownMatch && markdownMatch[1]) {
      heading = cleanHeadingLabel(markdownMatch[1])
    }

    if (!heading) {
      const colonMatch = trimmed.match(/^([A-Z][A-Za-z0-9&/(),.'\-\s]{2,90}):\s*$/)
      if (colonMatch && colonMatch[1]) {
        heading = cleanHeadingLabel(colonMatch[1])
      }
    }

    if (!heading) continue

    const normalized = normalizeHeading(heading)
    if (!normalized) continue
    if (normalized.includes('table of contents')) continue
    if (normalized === 'contents') continue

    if (!seen.has(normalized)) {
      seen.add(normalized)
      headings.push(heading)
    }

    if (headings.length >= 20) break
  }

  return headings
}

function inferTemplateFromDocuments(documents) {
  if (!documents || documents.length === 0) return null

  const headingStats = new Map()

  documents.forEach((doc) => {
    const headings = extractTemplateHeadings(doc.content)
    headings.forEach((heading, index) => {
      const normalized = normalizeHeading(heading)
      if (!normalized) return
      if (normalized.includes('investment memo')) return

      const current = headingStats.get(normalized) || {
        label: heading,
        count: 0,
        indexSum: 0
      }

      current.count += 1
      current.indexSum += index

      if (heading.length > current.label.length) {
        current.label = heading
      }

      headingStats.set(normalized, current)
    })
  })

  if (headingStats.size === 0) return null

  const docCount = documents.length
  const minimumCount = docCount >= 5 ? Math.ceil(docCount * 0.4) : Math.min(2, docCount)

  const selected = [...headingStats.entries()]
    .map(([normalized, info]) => ({
      normalized,
      label: info.label,
      count: info.count,
      avgIndex: info.indexSum / Math.max(info.count, 1)
    }))
    .filter((item) => item.count >= minimumCount)
    .sort((a, b) => {
      if (a.avgIndex !== b.avgIndex) return a.avgIndex - b.avgIndex
      if (a.count !== b.count) return b.count - a.count
      return a.label.localeCompare(b.label)
    })
    .slice(0, 12)

  const fallbackHeadings = ['Thesis', 'Why Now', 'Risks / Open Questions', 'Next Steps']
  const headingLabels = selected.length >= 3 ? selected.map((item) => item.label) : fallbackHeadings

  const lines = ['# {{company_name}} Investment Memo', '']
  for (const heading of headingLabels) {
    lines.push(`## ${heading}`)
    lines.push('- ')
    lines.push('')
  }

  return {
    templateMarkdown: lines.join('\n').trimEnd(),
    selectedHeadings: headingLabels,
    documentCount: docCount,
    minimumCount
  }
}

function createBackup(dbPath) {
  const timestamp = new Date().toISOString().replace(/[.:]/g, '-')
  const backupPath = `${dbPath}.bak-${timestamp}`
  fs.copyFileSync(dbPath, backupPath)
  return backupPath
}

function ensureCompanyByName(db, name) {
  const canonicalName = cleanDisplayName(name)
  const normalizedName = normalizeName(canonicalName)
  if (!canonicalName || !normalizedName) return null

  const existing = db
    .prepare('SELECT id, canonical_name, normalized_name FROM org_companies WHERE normalized_name = ? LIMIT 1')
    .get(normalizedName)
  if (existing) return existing

  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO org_companies (
      id,
      canonical_name,
      normalized_name,
      status,
      entity_type,
      include_in_companies_view,
      classification_source,
      classification_confidence,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, 'active', 'unknown', 1, 'manual', 1, datetime('now'), datetime('now'))
  `).run(id, canonicalName, normalizedName)

  return {
    id,
    canonical_name: canonicalName,
    normalized_name: normalizedName
  }
}

async function run() {
  const options = parseArgs(process.argv)
  const inputPath = path.resolve(options.inputPath)
  const dbPath = path.resolve(options.dbPath)
  const tokenFilePath = path.resolve(options.tokenFile)

  if (!fs.existsSync(dbPath)) {
    throw new Error(`DB not found: ${dbPath}`)
  }

  const sourceMode = resolveSourceMode(inputPath, options.source)

  console.log(`[Memo Import] Source mode: ${sourceMode}`)
  console.log(`[Memo Import] Input: ${inputPath}`)
  console.log(`[Memo Import] DB: ${dbPath}`)
  if (sourceMode === 'csv-google-docs') {
    console.log(`[Memo Import] Token cache: ${tokenFilePath}`)
  }

  const records = sourceMode === 'csv-google-docs'
    ? parseCsvRows(inputPath)
    : parseLocalInputRecords(inputPath)

  const recordsToProcess = options.limit ? records.slice(0, options.limit) : records

  if (recordsToProcess.length === 0) {
    console.log('[Memo Import] No records to process')
    return
  }

  console.log(`[Memo Import] Parsed ${recordsToProcess.length} record(s)`)

  let googleAuthClient = null
  if (sourceMode === 'csv-google-docs') {
    googleAuthClient = await authorizeGoogle(options)
    console.log('[Memo Import] Google authorization ready')
  }

  if (!options.dryRun && options.backup) {
    const backupPath = createBackup(dbPath)
    console.log(`[Memo Import] Backup created: ${backupPath}`)
  }

  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')

  const matchCompany = loadCompanyMatcher(db)

  const findLatestMemoStmt = db.prepare(`
    SELECT id, title, latest_version_number
    FROM investment_memos
    WHERE company_id = ?
    ORDER BY datetime(updated_at) DESC
    LIMIT 1
  `)

  const insertMemoStmt = db.prepare(`
    INSERT INTO investment_memos (
      id, company_id, title, status, latest_version_number, created_by, created_at, updated_at
    )
    VALUES (?, ?, ?, 'draft', 0, 'Memo Import', datetime('now'), datetime('now'))
  `)

  const getLatestVersionStmt = db.prepare(`
    SELECT id, version_number, content_markdown
    FROM investment_memo_versions
    WHERE memo_id = ?
    ORDER BY version_number DESC
    LIMIT 1
  `)

  const insertVersionStmt = db.prepare(`
    INSERT INTO investment_memo_versions (
      id, memo_id, version_number, content_markdown, structured_json, change_note, created_by, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'Memo Import', datetime('now'))
  `)

  const updateMemoLatestStmt = db.prepare(`
    UPDATE investment_memos
    SET latest_version_number = ?, updated_at = datetime('now')
    WHERE id = ?
  `)

  const upsertSettingStmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `)

  const localContentByStem = buildLocalContentIndex(recordsToProcess)
  const extractedCache = new Map()

  const stats = {
    processed: 0,
    imported: 0,
    skippedNoDocId: 0,
    skippedNoCompanyMatch: 0,
    skippedDuplicateContent: 0,
    skippedEmptyContent: 0,
    skippedGdocPointerOnly: 0,
    failed: 0,
    createdCompanies: 0
  }

  const importedForTemplate = []

  try {
    for (const record of recordsToProcess) {
      stats.processed += 1
      const rowLabel = `row ${record.rowNumber}`

      let companyMatch = matchCompany(record.memoName)
      if (!companyMatch && options.createMissingCompanies) {
        const firstCandidate = extractCompanyCandidates(record.memoName)[0] || record.memoName
        const created = options.dryRun
          ? { id: '(dry-run)', canonical_name: firstCandidate }
          : ensureCompanyByName(db, firstCandidate)
        if (created) {
          stats.createdCompanies += 1
          companyMatch = {
            company: created,
            matchedBy: 'created',
            matchedText: firstCandidate
          }
        }
      }

      if (!companyMatch) {
        stats.skippedNoCompanyMatch += 1
        console.warn(`[Memo Import] ${rowLabel}: no company match for "${record.memoName}" (${record.sourceLabel})`)
        continue
      }

      const extractionCacheKey = record.sourceType === 'google_doc_csv'
        ? `doc:${record.docId || 'missing'}`
        : `path:${record.sourcePath}`

      let extracted = extractedCache.get(extractionCacheKey)
      if (!extracted) {
        try {
          extracted = await getContentForRecord(record, {
            sourceMode,
            googleAuthClient,
            localContentByStem
          })
          extractedCache.set(extractionCacheKey, extracted)
        } catch (error) {
          stats.failed += 1
          console.error(
            `[Memo Import] ${rowLabel}: failed to extract content for ${record.sourceLabel} (${error.message})`
          )
          continue
        }
      }

      if (record.sourceType === 'google_doc_csv' && extracted.skipReason === 'missing_doc_id') {
        stats.skippedNoDocId += 1
        console.warn(`[Memo Import] ${rowLabel}: missing doc id in URL for ${record.sourceLabel}`)
        continue
      }

      if (!extracted.contentMarkdown) {
        if (extracted.skipReason === 'gdoc_pointer_without_local_content') {
          stats.skippedGdocPointerOnly += 1
          console.log(
            `[Memo Import] ${rowLabel}: skipped gdoc pointer without local content (${record.sourceLabel})`
          )
        } else {
          stats.skippedEmptyContent += 1
          console.log(`[Memo Import] ${rowLabel}: skipped empty content (${record.sourceLabel})`)
        }
        continue
      }

      const contentMarkdown = String(extracted.contentMarkdown || '').trim()
      if (!contentMarkdown) {
        stats.skippedEmptyContent += 1
        console.log(`[Memo Import] ${rowLabel}: skipped empty content (${record.sourceLabel})`)
        continue
      }

      const contentHash = hashContent(contentMarkdown)
      const companyId = companyMatch.company.id
      const companyName = companyMatch.company.canonical_name

      const latestMemo = findLatestMemoStmt.get(companyId)

      let memoId = latestMemo ? latestMemo.id : null
      if (!memoId && !options.dryRun) {
        memoId = crypto.randomUUID()
        insertMemoStmt.run(memoId, companyId, `${companyName} Investment Memo`)
      }

      const latestVersion = memoId ? getLatestVersionStmt.get(memoId) : null
      const latestHash = latestVersion ? hashContent(latestVersion.content_markdown || '') : null

      if (latestHash && latestHash === contentHash) {
        stats.skippedDuplicateContent += 1
        console.log(`[Memo Import] ${rowLabel}: skipped duplicate content for ${companyName}`)
        continue
      }

      const nextVersionNumber = latestVersion ? Number(latestVersion.version_number) + 1 : 1
      const structuredJson = safeJsonStringify({
        source: sourceMode,
        sourceType: record.sourceType,
        sourceLabel: record.sourceLabel,
        sourcePath: record.sourcePath || null,
        sourceUrl: record.sourceUrl || null,
        sourceDocId: record.docId || extracted.sourceMeta?.sourceDocId || null,
        sourceDocUrl: extracted.sourceMeta?.sourceDocUrl || null,
        linkedSourcePath: extracted.sourceMeta?.linkedSourcePath || null,
        importedAt: new Date().toISOString(),
        contentHash
      })

      if (!options.dryRun) {
        const memoVersionId = crypto.randomUUID()
        insertVersionStmt.run(
          memoVersionId,
          memoId,
          nextVersionNumber,
          contentMarkdown,
          structuredJson,
          `Imported from ${record.sourceLabel}`
        )
        updateMemoLatestStmt.run(nextVersionNumber, memoId)
      }

      if (extracted.sourceMeta?.templateEligible && contentMarkdown.length >= 200) {
        importedForTemplate.push({
          companyId,
          companyName,
          content: contentMarkdown,
          sourceName: record.memoName,
          sourceLabel: record.sourceLabel
        })
      }

      stats.imported += 1
      console.log(
        `[Memo Import] ${rowLabel}: imported ${companyName} (${companyMatch.matchedBy} match on "${companyMatch.matchedText}", v${nextVersionNumber})`
      )
    }

    if (options.updateTemplate && importedForTemplate.length > 0) {
      const templateResult = inferTemplateFromDocuments(importedForTemplate)
      if (templateResult && templateResult.templateMarkdown) {
        if (!options.dryRun) {
          upsertSettingStmt.run(options.templateSettingKey, templateResult.templateMarkdown)
        }
        console.log(
          `[Memo Import] ${options.dryRun ? 'Would update' : 'Updated'} template setting "${options.templateSettingKey}" from ${templateResult.documentCount} memo(s)`
        )
        console.log('[Memo Import] Inferred sections:', templateResult.selectedHeadings.join(' | '))
      } else {
        console.log('[Memo Import] Could not infer stable section headings; keeping existing template')
      }
    }

    console.log('')
    console.log('[Memo Import] Done')
    console.log(`  Processed: ${stats.processed}`)
    console.log(`  Imported: ${stats.imported}`)
    console.log(`  Skipped (missing doc id): ${stats.skippedNoDocId}`)
    console.log(`  Skipped (no company match): ${stats.skippedNoCompanyMatch}`)
    console.log(`  Skipped (duplicate): ${stats.skippedDuplicateContent}`)
    console.log(`  Skipped (empty content): ${stats.skippedEmptyContent}`)
    console.log(`  Skipped (gdoc pointer only): ${stats.skippedGdocPointerOnly}`)
    console.log(`  Failed: ${stats.failed}`)
    if (options.createMissingCompanies) {
      console.log(`  Created companies: ${stats.createdCompanies}`)
    }

    if (options.dryRun) {
      console.log('[Memo Import] Dry run only. No DB writes were made.')
    }
  } finally {
    db.close()
  }
}

run().catch((error) => {
  console.error('[Memo Import] Fatal error:', error && error.message ? error.message : error)
  process.exit(1)
})
