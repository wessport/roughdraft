# Decisions

- **2026-09-10 — Roughdraft publication:** The user explicitly requires that agents never push these changes to the parent/upstream repository (`Lex-Inc/roughdraft`, currently `origin`) and never open a PR/MR for this project on their behalf. Keep maintenance local; a local branch or commit is not permission to publish. This overrides the repository's generic PR workflow. Source: https://ampcode.com/threads/T-01a08bbc-4b82-7331-96ab-69ab841545e1.
- **2026-10-16 — Fork backup:** The user created the fork `wessport/roughdraft` (public, remote `fork`) to back up local branches. Pushing topic branches there is allowed; pushing to `Lex-Inc/roughdraft` and opening PRs/MRs remain prohibited.
