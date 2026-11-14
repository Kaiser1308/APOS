Captured 2026-11-14 with Orca: `worker-start --agent claude` opens Claude as a structured chat
(handle `structworker_...`), not a TUI. `terminal read` returns a transcript (`[user]`, `[assistant]`,
`[assistant] [tool X] {...}`). Orca delivers the brief itself, so there is no composer to rescue:
`unsentBrief` is always false for claude. Quota lines are the real text seen in Claude sessions
(`orca search "hit your limit"`), shown here in chat-transcript form; the TUI form is unverified.
