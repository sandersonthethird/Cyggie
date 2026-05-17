// Sentinel markers wrapping FTS snippet matches. Using U+2063 (invisible
// separator) makes it vanishingly unlikely that the sentinel collides with
// literal user-typed HTML in transcripts or notes — earlier the snippet used
// `<mark>` strings, which a malicious or accidental paste could forge.
//
// Both main (SQLite snippet() call) and renderer (MeetingCard split-and-render)
// import these constants so the encoding stays in lock-step.
export const FTS_MARK_START = '⁣MARK⁣'
export const FTS_MARK_END = '⁣/MARK⁣'
