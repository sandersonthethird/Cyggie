# TODOS

## P2 — Email Sync

### Determinate progress bar during email discovery
**What:** Show a progress bar (not just text) once the total message count is known.
**Why:** The current "Fetching 42 of 312…" text is helpful but a visual progress bar would make long syncs much less anxiety-inducing.
**Effort:** S
**Context:** The `COMPANY_EMAIL_INGEST_PROGRESS` and `CONTACT_EMAIL_INGEST_PROGRESS` channels already emit `{ phase, fetched, total }`. The `total` is known after the discovering phase completes. Add a `<progress>` element or a CSS-based bar to the sync row in `CompanyTimeline.tsx` and `ContactEmails.tsx`.

---

## P2 — Contact Detail

### Unified contact timeline
**What:** Add a Timeline tab to ContactDetail showing meetings + emails + notes in chronological order, mirroring `CompanyTimeline`.
**Why:** Right now the contact view has three separate tabs. A unified timeline makes it easy to see the arc of a relationship at a glance — matching the company view's most useful feature.
**Effort:** M
**Context:** The repo layer already has `listCompanyTimeline` in `org-company.repo.ts`. A parallel `listContactTimeline` query would join `meetings` (by attendee email), `email_messages` (via `email_contact_links`), and `contact_notes` into a single chronological feed. The renderer component would mirror `CompanyTimeline.tsx` but without email-sync controls.
