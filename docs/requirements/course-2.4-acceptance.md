# Course OS 2.4 acceptance

## Public baseline

The public repository contains source code, synthetic fixtures, parameterized deployment templates, and deterministic verification only. It contains no real course pages, screenshots, learner records, databases, logs, production evidence, hostnames, private paths, or secrets.

## Private course acceptance

The private runtime acceptance set pins two formal modules:

- Introduction v4: 25 pages.
- Chapter 2 v5: 47 pages.
- Combined formal course: 72 pages.

Formal tree queries must exclude synthetic, legacy, regression, other-workspace, archived, and draft-source content. Every page, question, review item, and randomized assessment must remain bound to its workspace and immutable release.

## Interaction acceptance

Mouse, touch, and keyboard tree movement must produce the same persisted ordering. Reload must preserve release, page, zoom, and pan. The player shows one source visual on the left and teaching content on the right, including KaTeX and line-by-line pseudocode explanations.

## Operational acceptance

ReadWeave errors are controlled and disclose no token, raw upstream response, or server detail. State promotion is dry-run by default, creates missing objects only, and stops on hash conflicts. Deployment requires an exact public commit, immutable runtime and converter images, at least 40 GB free disk, verified backups, health checks, authentication checks, restart persistence, and a retained rollback point.
