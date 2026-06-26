# Claude Code prompt — Cyggie desktop onboarding flow

> Copy everything in the fenced block below into Claude Code, run from the repo root.
> Make sure the two reference files are in the repo first (see "Before you paste" underneath).

## Before you paste
1. Drop this whole `design_handoff_onboarding/` folder somewhere in the repo (e.g. `design/onboarding/`).
2. Open `onboarding-design-reference.html` in a browser once to see the intended look and click through the flow. It's a self-contained design mock — **a visual reference, not code to copy**. The "Tweaks" panel in it (alternate progress styles, split layout, accent colors) is exploration scaffolding; ship the **defaults**: railroad progress bar, centered layout, crimson accent.

---

```
You're working in the Cyggie repo — an Electron + React 19 + TypeScript desktop app (electron-vite, react-router-dom v7 HashRouter, Zustand v5, CSS Modules, lucide-react, Inter via @fontsource). Build the first-run **welcome / onboarding / implementation flow** for the desktop renderer.

A design reference is at design/onboarding/onboarding-design-reference.html (open it in a browser). It is a visual spec built in plain HTML — recreate it in our renderer using our existing conventions and tokens. Do NOT copy its markup or inline styles, and do NOT port its React/Babel/tweaks-panel scaffolding. Match the look, not the code.

## What to build
A 6-screen first-run flow shown full-window before the main app, with a railroad-tile progress bar across the four setup steps:

  0. Sign in        — Cyggie app icon, "Sign in with Google", and "Use locally without an account". (No progress bar on this screen.)
  1. Workspace      — firm name + auto-derived workspace URL slug. [progress step 1]
  2. Google         — connect Google so the calendar can build companies/contacts. [step 2, skippable]
  3. Keys           — Deepgram + Anthropic API keys (transcription + AI). [step 3, skippable]
  4. Team           — invite teammates by email, list pending invites. [step 4, skippable]
  5. You're all set — summary of what was configured, "Enter Cyggie". (No progress bar.)

Steps 2–4 are the third screen from the original design, deliberately split into three standalone steps.

## Gate it into the app
- Add an onboarding gate in src/renderer/App.tsx that renders the flow full-screen *before* the `<Layout>` routes when onboarding has not been completed.
- Persist a completion flag (e.g. `onboardingComplete`) through the existing preferences path — usePreferencesStore (stores/preferences.store.ts), which is IPC-backed via IPC_CHANNELS.USER_PREF_GET_ALL / USER_PREF_SET. On relaunch, a completed user goes straight to the app.
- "Use locally without an account" must let the user finish without signing in — completion is NOT gated on auth.
- Persist in-progress step + collected field values too (same preferences path or localStorage) so a reload resumes where they were.

## Wire to existing systems — do not reinvent
- **Google sign-in (step 0):** reuse the existing desktop auth. Trigger IPC_CHANNELS.CYGGIE_AUTH_SIGN_IN (main/auth/cyggie-auth.ts `startSignIn`) and react to the CYGGIE_AUTH_STATUS_CHANGED broadcast; read state with CYGGIE_AUTH_STATUS. Sign-in opens the system browser and returns asynchronously — show a pending state and advance when status flips to signed-in.
- **Google connect (step 2):** this is calendar access. Follow the existing Google calendar auth path (main/calendar/google-auth.ts) rather than literally collecting a client ID/secret. If our flow is gateway-OAuth, replace the reference's id/secret fields with a single "Connect Google" button that kicks off that flow; keep "Skip for now".
- **Keys (step 3):** persist Deepgram + Anthropic keys the same way Settings does (see components/settings/TranscriptionProviderSection.tsx and lib/safe-storage.ts for secret storage). Reuse the same setting keys so what's entered here shows up in Settings, and skipping is fine.
- **Team invites (step 4):** if the gateway exposes an invite endpoint, call it through a new IPC channel; if not, persist pending invites locally and leave a clearly-marked TODO + stub IPC so the backend can be filled in. Validate email format; allow add/remove of multiple; "Continue" works with zero invites.

## Conventions to follow
- Routing: HashRouter is already set up in App.tsx; the gate is a conditional render, not a new route under `<Layout>`.
- Styling: CSS Modules + our CSS variables (see styles/globals.css), the same pattern as routes/Settings.module.css. No Tailwind utility soup, no styled-components.
- Reuse tokens: crimson = var(--cv-crimson) #B91C1C (hover --cv-crimson-hover #991B1B, tint --cv-crimson-muted #FEF2F2); text --color-text; surfaces --color-card-bg / --color-bg; borders --color-border; radii --radius-md/--radius-lg; --font-sans.
- **New navy accent:** the design introduces a subtle cool navy sampled from build/icon.png. Add tokens to globals.css and use them for the page wash, input wells, and the *incomplete* progress states (keep crimson as the action/active color):
    --cv-navy: #0F172A;  --cv-navy-700: #1E293B;  --cv-navy-300: #94A3B8;
    --cv-navy-tint: #EDF1F8;  --cv-navy-line: #E2E8F1;  --cv-navy-wash: #F4F6FB;
- Icons: lucide-react (already a dep). Use the real Cyggie app icon (build/icon.png — navy rounded-square with the crimson swan) for the sign-in hero and the window title strip; do not redraw the swan in SVG.
- The window already has a custom titlebar (--titlebar-height); render the flow inside the existing chrome, don't add a second title bar.

## Railroad progress bar (the signature element)
A horizontal row of four equal tiles (Workspace · Google · Keys · Team), each with a number badge + label:
- done → crimson-tint fill, crimson badge with a check, clickable to go back to that step;
- current → crimson border + soft crimson focus ring;
- upcoming → navy-tint fill, muted navy badge/label, not clickable.
Build it as one reusable `<RailProgress steps current onJump />` component. (The reference also shows "nodes" and "segmented bar" variants — those were design options; build only the railroad tiles unless asked.)

## Visual spec (from the reference)
- Centered white card (~480px; ~540px on the summary), radius ~18px, soft shadow, on the navy wash.
- Inputs: ~46px tall, radius 12, navy-tint well, crimson focus ring; mono font for key/ID fields.
- Primary button: crimson, ~48px tall, full width, 700 weight; secondary = outline; skip = quiet underline link.
- Workspace slug auto-derives from the firm name (lowercase, non-alphanumerics → hyphens) until the user edits the slug directly.
- Summary screen lists Workspace / Google / AI & recording keys / Team with done-or-skipped state reflecting real choices.
- Inter throughout; headings ~27px/800, sub ~15.5px in --color-text-secondary.

## State
A small zustand store (stores/onboarding.store.ts) or local state in the gate, holding: current step, firmName, slug, googleConnected, keysSaved, invites[], and the completion flag. Mirror step + values to the preferences/localStorage path on change; hydrate on mount.

## Suggested file layout
  src/renderer/components/onboarding/Onboarding.tsx          (gate + step switch)
  src/renderer/components/onboarding/RailProgress.tsx
  src/renderer/components/onboarding/steps/SignInStep.tsx
  src/renderer/components/onboarding/steps/WorkspaceStep.tsx
  src/renderer/components/onboarding/steps/GoogleStep.tsx
  src/renderer/components/onboarding/steps/KeysStep.tsx
  src/renderer/components/onboarding/steps/TeamStep.tsx
  src/renderer/components/onboarding/steps/DoneStep.tsx
  src/renderer/components/onboarding/Onboarding.module.css
  src/renderer/stores/onboarding.store.ts
  (+ globals.css navy tokens, App.tsx gate, any new IPC channel in shared/constants/channels.ts)

## Acceptance criteria
- First launch (or cleared flag) shows Sign in; completing or "Enter Cyggie" lands in the existing Dashboard and never shows onboarding again unless the flag is reset.
- Railroad bar reflects progress, fills with checks, and lets you jump back to a completed step. Back button works on every setup step.
- Google sign-in actually triggers the existing auth IPC; Google connect uses the existing calendar auth; keys persist into the same store Settings reads; invites validate email and add/remove.
- Steps 2–4 are independently skippable; the local path needs no account.
- Visual result matches design/onboarding/onboarding-design-reference.html (railroad + centered + crimson defaults) using our tokens and CSS-module conventions — no new heavy dependencies.

## Don't
- Don't ship the reference HTML/JSX or its tweaks panel.
- Don't introduce a parallel color system — reuse our tokens and add only the navy vars above.
- Don't gate completion on sign-in. Don't add a second titlebar. Don't redraw the swan as SVG — use build/icon.png.

Start by reading App.tsx, stores/preferences.store.ts, main/auth/cyggie-auth.ts, main/calendar/google-auth.ts, components/settings/TranscriptionProviderSection.tsx and styles/globals.css, then propose the file plan and the App.tsx gate before implementing.
```
