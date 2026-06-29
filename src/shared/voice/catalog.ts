// Cyggie brand voice — the copy catalog.
//
// Tone: bold & irreverent — confident, a little roasty, in on the joke of
// venture. Three tiers per slot:
//   plain  → the original neutral copy. Also what `off` renders and the
//            straight-path fallback. Must always read as a normal product string.
//   subtle → a light wink, safe for most audiences.
//   full   → the bold voice.
//
// RULES when editing:
//   • Never bury a number/outcome the user must read inside a joke. Flavor is
//     appended around data at the call site, not encoded here.
//   • Onboarding `plain` lines must still convey the real instruction — voice
//     is a tone layer, not a content swap.
//   • Keep it cheeky, never mean-spirited or offensive.

import type { VoiceCatalog } from './types'

export const voiceCatalog: VoiceCatalog = {
  emptyState: {
    contacts: {
      plain: 'No contacts found.',
      subtle: ['No contacts yet.', 'Nobody here yet.'],
      full: [
        'Zero contacts. Bold networking strategy.',
        "Nobody here. Your CRM is technically 'in stealth.'",
        "No contacts yet. Even your LP list is jealous.",
        "Crickets. Not even a single 'let's grab coffee.'",
      ],
      filtered: {
        plain: 'No contacts match your search.',
        subtle: ['No contacts match that one.'],
        full: [
          'No matches. That filter is doing a lot of work.',
          "Nothing fits that search. Pickier than a Series A lead.",
        ],
      },
    },
    companies: {
      plain: 'No companies found.',
      subtle: ['No companies yet.', 'Nothing in the pipeline yet.'],
      full: [
        'Zero deals. Bold strategy.',
        'Pipeline: empty. Vibes: stealth.',
        "No companies. Your anti-portfolio thanks you.",
        "Nothing here. Dry powder's looking awfully dry.",
      ],
      filtered: {
        plain: 'No companies match your search.',
        subtle: ['No companies match that one.'],
        full: [
          "No results for that search. Honestly? Good.",
          'Nothing matches. Even your filter has standards.',
        ],
      },
    },
    notes: {
      plain: 'No notes yet.',
      subtle: ['No notes yet.', 'Nothing written down yet.'],
      full: [
        "No notes. 'I'll remember' — famous last words of every GP.",
        'No notes. Living dangerously, I see.',
        "Nothing written down. Bold for someone who signs term sheets.",
        'No notes yet. Future-you is already annoyed.',
      ],
    },
    deals: {
      plain: 'No decisions logged yet.',
      subtle: ['No decisions logged yet.', 'No pipeline history yet.'],
      full: [
        "No decisions yet. 'We'll circle back' isn't a decision.",
        "Empty. Pass, pass, pass — at least log them?",
        "No pipeline history. We'll pretend you've been 'heads down.'",
      ],
    },
    meetings: {
      plain: 'No meetings found.',
      subtle: ['No meetings yet.'],
      full: [
        'No meetings. The calendar gods are unimpressed.',
        "Nothing booked. Even your auto-decline is bored.",
      ],
      filtered: {
        plain: 'No meetings match the current filter.',
        full: ['No meetings match that. Try a wider net.'],
        subtle: ['No meetings match that one.'],
      },
    },
    timeline: {
      plain: 'No timeline activity yet.',
      subtle: ['No activity yet.'],
      full: [
        'No activity yet. Quiet. Suspiciously quiet.',
        "Nothing here yet. The relationship is pre-seed.",
      ],
      filtered: {
        plain: 'No matching activity.',
        full: ['Nothing matches that filter.'],
        subtle: ['No matching activity.'],
      },
    },
    decisions: {
      plain: 'No decisions logged yet.',
      subtle: ['No decisions logged yet.'],
      full: [
        "No decisions yet. Conviction is a verb, just saying.",
        'Nothing logged. The IC will have a quiet meeting.',
      ],
    },
    memo: {
      plain: 'No memo yet. Click Generate with AI to create one.',
      subtle: ['No memo yet — generate one with AI to get started.'],
      full: [
        "No memo yet. Hit Generate and let the robot do diligence.",
        "Blank memo. Conviction doesn't write itself — generate one.",
      ],
    },
    chats: {
      plain: 'No chats yet. Start one below.',
      subtle: ['No chats yet — start one below.'],
      full: [
        "No chats yet. Go on, ask the all-knowing CRM something.",
        "Nothing here. Start a chat — it's smarter than your last analyst.",
      ],
    },
    generic: {
      plain: 'Nothing here yet.',
      subtle: ['Nothing here yet.'],
      full: ['Empty. A blank slate, full of potential markups.'],
      filtered: {
        plain: 'No results.',
        full: ['No results. That filter means business.'],
        subtle: ['No results.'],
      },
    },
  },

  loading: {
    generic: {
      plain: 'Loading…',
      subtle: ['Loading…', 'One sec…'],
      full: [
        'Loading… faster than a follow-on decision.',
        'Crunching numbers no LP will ever see.',
        "Loading… don't worry, no carry was harmed.",
        'One sec — running diligence at warp speed.',
      ],
    },
    integrations: {
      plain: 'Syncing…',
      subtle: ['Syncing…'],
      full: [
        'Syncing… smoother than your LP update.',
        'Syncing… herding every last data point.',
      ],
    },
  },

  toast: {
    syncUpToDate: {
      plain: 'Up to date',
      subtle: ['Up to date', 'All caught up'],
      full: [
        "Already perfect. Suspicious, but we'll take it.",
        'Up to date. Nothing to see here, overachiever.',
        'All caught up. Go bother a founder.',
        "Nothing new. Inbox zero's cooler cousin.",
        "Synced. Cleaner than your cap table.",
      ],
    },
  },

  error: {
    chatStart: {
      plain: 'Could not start a new chat. Please try again.',
      subtle: ["Couldn't start that chat — give it another go."],
      full: [
        "That failed. Blame the macro environment. Retry?",
        "Hiccup — couldn't start the chat. Even great funds have down rounds. Try again.",
      ],
    },
  },

  milestone: {
    firstContact: {
      plain: 'First contact added.',
      subtle: ['First contact added — nice.'],
      full: [
        'First contact added. The network effect starts now.',
        "First contact. One down, the rest of your Rolodex to go.",
      ],
    },
    firstCompany: {
      plain: 'First company added.',
      subtle: ['First company added — nice.'],
      full: [
        'First company logged. The fund is technically deploying capital now.',
        "First company in. Anti-portfolio, eat your heart out.",
      ],
    },
    meetingCentury: {
      plain: '100 meetings recorded.',
      subtle: ['100 meetings recorded — milestone unlocked.'],
      full: [
        '100 meetings recorded. That is a lot of "let me circle back."',
        "100 meetings. Someone get this partner a standing desk.",
      ],
    },
  },

  onboarding: {
    signIn: {
      plain: 'Sign in to sync your work across devices — or use Cyggie locally on this Mac.',
      subtle: ['Sign in to sync everywhere — or keep it local on this Mac.'],
      full: [
        'Sign in to sync across devices — or run Cyggie local, lone-wolf style.',
        'Sync everywhere, or keep it on this Mac. No FOMO either way.',
      ],
    },
    workspace: {
      plain: 'This is how your firm shows up across Cyggie.',
      subtle: ["Your firm's name — this is how it shows up across Cyggie."],
      full: [
        'Name your firm. This is the brand LPs will pretend to remember.',
        "Your firm's name — make it sound like it raised a Fund III.",
      ],
    },
    storage: {
      plain: 'Choose where your meeting files live — private stays on this Mac, shared goes to your firm folder.',
      subtle: ['Private files stay on this Mac; shared files go to your firm folder. Pick your spots.'],
      full: [
        'Private files stay on this Mac. Shared files go to the firm folder. Boundaries — healthy.',
        "Your stuff on this Mac, the firm's stuff in the shared folder. Everyone gets their lane.",
      ],
    },
    google: {
      plain: "Cyggie reads your calendar to build your firm's companies and contacts automatically.",
      subtle: ["Connect Google and Cyggie builds your companies and contacts from your calendar."],
      full: [
        'We read your calendar and build your companies and contacts. You take the credit.',
        "Connect Google — we'll do the diligence on your own schedule. Literally.",
      ],
    },
    keys: {
      plain: 'Deepgram transcribes meetings; Anthropic powers AI. You can add these later in Settings.',
      subtle: ['Deepgram transcribes; Anthropic does the AI. Add them later in Settings if you like.'],
      full: [
        "Deepgram transcribes; Anthropic does the smart stuff. Add later in Settings if you're commitment-averse.",
        "Two keys, infinite leverage. Or skip and add them later — we won't tell your LPs.",
      ],
    },
    team: {
      plain: "Add teammates by email. They'll sign in to Cyggie with the same address.",
      subtle: ['Invite teammates by email — they sign in with the same address.'],
      full: [
        'Invite your team by email. They sign in with the same address — no secret handshake.',
        'Add the people who actually do the work. By email, naturally.',
      ],
    },
    done: {
      plain: 'You can finish anything you skipped in Settings.',
      subtle: ['All set — finish anything you skipped in Settings.'],
      full: [
        'Finish anything you skipped in Settings — no judgment, mostly.',
        'Ready to deploy capital. Or at least to look organized doing it.',
      ],
    },
  },
}

/**
 * Late-night loading lines (shown ~22:00–05:00). Kept separate from the main
 * `loading` slots so the time-of-day wink doesn't dilute the daytime pool.
 */
export const lateNightLoading: readonly string[] = [
  "Loading… it's late. The founders can wait till morning.",
  'Loading… burning the midnight oil, are we?',
  "Loading… go home, the term sheet will still be there tomorrow.",
]
