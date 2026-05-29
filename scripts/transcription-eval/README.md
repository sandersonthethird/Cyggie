# transcription-eval

Offline tool for comparing transcription provider quality on real meeting
audio. Two providers supported: **Deepgram batch (nova-3)** and
**AssemblyAI Universal-3**.

Voxtral was removed 2026-05-28 after the eval surfaced two disqualifying
failures: a 16,384-token context limit (unusable for meetings over ~22
minutes) and degenerate output loops on long clips.

## Prerequisites

1. Run the desktop app at least once so the SQLite DB exists.
2. Enable Settings → AI & Transcription → Developer / Eval → "Save
   recorded audio for offline eval" so the AAC encoder writes
   `<recordingsDir>/<meetingId>.m4a` for every new recording.
3. Configure API keys in Settings → AI & Transcription (or via env vars
   `DEEPGRAM_API_KEY` / `ASSEMBLYAI_API_KEY`).

## Usage

```
pnpm eval:transcription -- --meeting=<id> --providers=deepgram_batch,assemblyai_universal3
pnpm eval:transcription -- --audio=./fixture.m4a --providers=assemblyai_universal3
pnpm eval:transcription -- --help
```

The CLI writes a markdown summary to
`<recordingsDir>/eval-results/eval-<timestamp>.md` containing a
provider-by-provider table with latency + cost-estimate + diarization
mode, plus a full-text dump per provider for side-by-side comparison.

Per-meeting segment JSON is written to
`<recordingsDir>/<meetingId>.<provider>.json` for spot-checking.

## Why this exists post-eval

The provider picker in the production app handles the day-to-day choice
of Deepgram vs AssemblyAI for live streaming. This CLI is for when you
want to retroactively re-transcribe a saved AAC file with a different
provider for accuracy comparisons or to evaluate future providers.
