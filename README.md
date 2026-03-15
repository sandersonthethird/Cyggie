# Cyggie

A private, local-first CRM and meeting intelligence tool for early-stage investors. Runs as a native macOS desktop app — all data stays on your machine.

---

## Features

### Meetings & Recording
- Live meeting recording with real-time transcription (Deepgram WebSocket streaming)
- Automatic speaker diarization
- AI summaries via Claude or local Ollama — fully customizable templates
- Per-meeting chat: ask questions grounded in the transcript
- Google Calendar integration: auto-detect current meeting, pre-populate attendees
- Google Drive upload for transcripts and summaries
- Import meeting notes from Granola

### CRM — Companies
- Sortable, resizable table view with column picker and saved views
- Pipeline board: Screening → Diligence → Decision → Documentation → Pass
- Per-company timeline: meetings, emails, notes, and decision log entries in one feed
- Type filter pills (meetings / emails / notes / decisions)
- AI company chat grounded in notes, emails, and memos
- Investment memo parsing and storage (PDF / Google Docs)
- Custom fields, portfolio tracking (investment size, ownership %, follow-on)

### CRM — Contacts
- Sortable table view with column picker
- Per-contact timeline: meetings, emails, notes
- AI contact chat grounded in relationship history
- Custom fields, contact type (Investor / Founder / Operator)

### Decision Log
- Structured investment decisions per company (Approved, Pass, Follow-on, Increase Allocation, etc.)
- Auto-prompts when a company moves to documentation or pass stage
- Auto-syncs deal terms (amount, ownership %) back to company portfolio fields

### Email
- Gmail sync per company or contact — pulls thread history into the timeline
- Incremental sync with live progress and cancel

### CSV Import
- Import contacts and/or companies from any CSV
- LLM-powered field mapping with alias-table fallback
- **Field defaults**: set contact type, title, city, state, entity type, or pipeline stage for all imported rows before the import runs
- Duplicate preview before committing
- "View N imported contacts →" shortcut after import, sorted by date added

### Search & Productivity
- Full-text search across meetings, companies, contacts, and notes (SQLite FTS5)
- Task list tied to companies and contacts
- Reusable meeting note templates

---

## Tech Stack

| Layer | Tech |
|-------|------|
| App shell | Electron |
| Frontend | React 19, React Router 7, Zustand |
| Language | TypeScript 5.7 |
| Build | electron-vite, Vite 6, electron-builder |
| Database | SQLite (better-sqlite3), 45 migrations |
| Transcription | Deepgram SDK |
| AI / LLM | Anthropic Claude API, Ollama (local) |
| Google | Calendar API, Gmail API, Drive API |
| Audio | electron-audio-loopback |
| Tests | Vitest |

---

## Getting Started

**Prerequisites:** Node.js 18+, npm, FFmpeg on `$PATH` (for video recording)

```bash
git clone https://github.com/sandersonthethird/Cyggie
cd Cyggie
npm install
npm run dev
```

On first launch, open **Settings** to configure API keys. The SQLite database is created automatically at `~/Library/Application Support/cyggie/`.

### API Keys

All keys are stored locally using Electron's encrypted safe storage — nothing is sent to Cyggie servers.

**Deepgram** (required for transcription)
Sign up at [console.deepgram.com](https://console.deepgram.com/signup) → API Keys → paste in **Settings > Transcription**. Free tier includes $200 credit.

**Anthropic** (required for AI summaries and chat)
Sign up at [console.anthropic.com](https://console.anthropic.com/) → API Keys → paste in **Settings > Summarization**. Alternatively, select **Ollama** to run a model locally for free.

**Google** (optional — Calendar, Gmail, Drive)
Connect your Google account in **Settings > Google Calendar**. The app walks through OAuth setup.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start in development mode with hot reload |
| `npm run build` | Compile all processes |
| `npm run package` | Build + package for macOS |
| `npm run package:win` | Build + package for Windows |
| `npm run test` | Run tests with Vitest |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run import:granola` | Import meeting notes from Granola |
| `npm run import:memos` | Import investment memos from Google Docs or local folder |

### Importing investment memos

Local folder mode:
```bash
npm run import:memos -- import/memos/raw --dry-run
npm run import:memos -- import/memos/raw
```

CSV + Google Docs mode:
```bash
npm run import:memos -- import/memos/raw/investment_memos.csv \
  --source csv-google-docs \
  --oauth-client /path/to/google-oauth-client.json \
  --token-file import/memos/.google-docs-token.json
```

Flags: `--dry-run`, `--create-missing-companies`, `--no-template-update`

---

## Project Structure

```
src/
  main/                    # Electron main process
    database/
      migrations/          # 45 SQL migrations (run on startup)
      repositories/        # SQLite query functions per entity
    ipc/                   # IPC handlers (one file per feature domain)
    llm/                   # Claude + Ollama providers, summarizer, chat
    services/              # csv-import, meeting-notes-backfill
    security/              # Credential encryption, current-user context
  preload/                 # Electron preload — exposes window.api to renderer
  renderer/                # React frontend
    api/                   # window.api wrapper
    components/            # UI components (company/, contact/, crm/, chat/, …)
    contexts/              # AudioCaptureContext
    hooks/                 # useEmailSync, useCalendar, useMeetings, useSearch, …
    routes/                # Page components
    stores/                # Zustand stores
    utils/                 # decisionLogTrigger, format helpers
  shared/
    constants/             # IPC channel names
    types/                 # Shared TypeScript types (company, contact, csv-import, …)
  tests/                   # Vitest test suites
```

---

## License

MIT
