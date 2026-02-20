# Cyggie

A desktop meeting intelligence system — capture, transcribe, summarize, and search your meetings with AI.

## Features

### Real-Time Transcription
- Live speech-to-text powered by [Deepgram](https://deepgram.com/) via WebSocket streaming
- Automatic speaker diarization — identifies and labels different speakers
- Pause and resume recording mid-meeting
- Auto-stop detection based on silence or calendar event end time

### AI-Powered Summaries
- Generate meeting summaries using **Claude** (Anthropic) or **Ollama** (local LLMs)
- Customizable summary templates with variable substitution (transcript, speakers, notes, etc.)
- Pre-built templates for common meeting types: VC Pitch, Founder Check-in, Partners Meeting, and more
- Create and manage your own templates

### Meeting Chat & Query
- Ask questions about any individual meeting with full transcript context
- Global query across all meetings with cited sources
- Streaming AI responses

### Google Calendar Integration
- Connect your Google Calendar via OAuth
- Auto-detect the current meeting from your calendar
- Pre-populate meeting titles and attendees
- Meeting notifications one minute before start

### Google Drive Upload
- Automatically upload transcripts and summaries to Google Drive
- Generate shareable links

### Full-Text Search
- Search across all transcripts and summaries using SQLite FTS5
- Advanced filters by speaker, date range, and more
- Ranked search results

### Meeting Management
- Browse, rename, and organize meetings
- Add preparation notes and attendee info
- Track meeting status: scheduled, recording, transcribed, summarized

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 40 |
| Frontend | React 19, React Router 7, Zustand |
| Language | TypeScript 5.7 |
| Build | Vite 6, electron-vite, electron-builder |
| Database | SQLite (better-sqlite3) with FTS5 |
| Transcription | Deepgram SDK |
| AI/LLM | Anthropic SDK (Claude), Ollama |
| Calendar & Drive | Google APIs |
| Audio Capture | electron-audio-loopback |
| Testing | Vitest, Testing Library |

## Prerequisites

- **Node.js** (v18 or later recommended)
- **npm**
- **Deepgram API key** — for real-time transcription ([get one here](https://console.deepgram.com/))
- **Anthropic API key** — for AI summaries and chat ([get one here](https://console.anthropic.com/))
- **Google OAuth credentials** — for Calendar and Drive integration
- **Ollama** *(optional)* — for local LLM support ([install Ollama](https://ollama.com/))

## Getting Started

```bash
# Clone the repository
git clone https://github.com/sandersonthethird/Cyggie
cd Cyggie

# Install dependencies
npm install

# Start the development server
npm run dev
```

Once the app launches, open **Settings** to configure your API keys (see below).

## API Key Setup

Cyggie requires your own API keys — no keys are included with the app. All keys are encrypted and stored locally on your machine using Electron's safe storage.

### 1. Deepgram (required for transcription)

1. Sign up for a free account at [console.deepgram.com](https://console.deepgram.com/signup)
2. Go to **API Keys** in the Deepgram dashboard and create a new key
3. In Cyggie, open **Settings > Transcription** and paste your key

Deepgram's free tier includes $200 in credit, which covers many hours of transcription.

### 2. Anthropic (required for AI summaries and chat)

1. Sign up at [console.anthropic.com](https://console.anthropic.com/)
2. Go to **Settings > API Keys** and create a new key
3. In Cyggie, open **Settings > Summarization**, select **Claude**, and paste your key

> **Free alternative:** If you'd prefer not to use a paid API, select **Ollama** as your LLM provider in Settings. [Install Ollama](https://ollama.com/) and run a model locally at no cost.

### 3. Google Calendar & Drive (optional)

To auto-detect meetings and upload files to Drive, connect your Google account in **Settings > Google Calendar**. The app will walk you through creating OAuth credentials.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the app in development mode with hot reload |
| `npm run build` | Compile the main, preload, and renderer processes |
| `npm run preview` | Preview the production build |
| `npm run package` | Build and package for macOS |
| `npm run package:win` | Build and package for Windows |
| `npm run test` | Run tests with Vitest |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Format code with Prettier |

## Project Structure

```
src/
├── main/                   # Electron main process
│   ├── audio/              # System audio capture
│   ├── calendar/           # Google Calendar OAuth & sync
│   ├── database/           # SQLite connection, migrations, repositories
│   ├── deepgram/           # Deepgram WebSocket client & transcript assembly
│   ├── drive/              # Google Drive upload
│   ├── ipc/                # IPC handlers (recording, summary, chat, etc.)
│   ├── llm/                # LLM providers (Claude, Ollama), summarizer, chat
│   ├── recording/          # Auto-stop logic
│   ├── security/           # Credential encryption
│   └── storage/            # File & path management
├── renderer/               # React frontend
│   ├── components/         # UI components (layout, meetings, chat, common)
│   ├── contexts/           # React contexts
│   ├── hooks/              # Custom hooks (IPC, meetings, search, calendar)
│   ├── routes/             # Pages (MeetingList, MeetingDetail, LiveRecording, etc.)
│   └── stores/             # Zustand state stores
├── preload/                # Electron preload scripts (IPC bridge)
└── shared/                 # Shared types, constants, and channel definitions
```

## License

MIT
