# Fast offline teaching evaluation

The rapid runner evaluates existing local release data without contacting ReadWeave, model providers, search providers, or Docker

## Inputs

The input may be a Course OS store JSON object with a `releases` array, an object containing release data, or a JSON array of releases

The runner reads optional metadata arrays when present, including `costEntries`, `generationErrors`, `repairTickets`, `repairEvents`, `generationEvents`, and `generationCheckpoints`

It preserves only operational metadata in its output, such as provider, model, stage, status, hashes, costs, durations, and repair counts

## Fixed manifest

Use [teaching-fast.example.json](../evals/teaching-fast.example.json) as a starting point

The manifest fixes the seed, concurrency cap, maximum page count, formal-release selection, page numbers, release IDs, feature tags, and domains

Feature tags are read from explicit page tags when available and are also inferred from page atoms and blocks for `formula`, `code`, `table`, `visual`, and `text`

Domains are read from release or page metadata and fall back to normalized module identifiers and titles

Selection is deterministic for the same input and manifest because the seed ranks pages by a stable hash

## Commands

Evaluate one local store and print JSON to standard output plus the Markdown summary to standard error

```text
pnpm eval:teaching:fast -- --input var/readweave-course-store.json --manifest evals/teaching-fast.example.json
```

Write both artifacts explicitly

```text
pnpm eval:teaching:fast -- --input var/readweave-course-store.json --manifest evals/teaching-fast.example.json --json-out var/eval/result.json --markdown-out var/eval/summary.md
```

Compare two offline result sources with the same manifest

```text
pnpm eval:teaching:fast -- --baseline var/baseline.json --candidate var/candidate.json --manifest evals/teaching-fast.example.json --json-out var/eval/compare.json --markdown-out var/eval/compare.md
```

The command exits non-zero for content or input failures, and also for comparison regressions

Set `EVAL_TEACHING_FAST_ALLOW_FAILURE=1` only when collecting a failing fixture intentionally

## Failure categories

| Category | Meaning | Evaluation effect |
| --- | --- | --- |
| `content` | Page structure, teaching, math, question, coverage, or publishability issue | Result status is `failed` |
| `provider` | Model, credential, quota, rate-limit, or provider response issue | Result status is `degraded` unless content also fails |
| `network` | Timeout, DNS, connection, ETAPI, or transport issue | Result status is `degraded` unless content also fails |
| `input` | Local source cannot be parsed or a page cannot be evaluated | Result status is `failed` |
| `unknown` | An operational failure did not match a known class | Result status is `degraded` |

Provider and network failures are retained on the page row and in aggregate counts instead of being reported as content defects

## Comparison output

The comparison records matched, baseline-only, and candidate-only pages, average-score delta, content/provider/network failure deltas, actual cost delta, and candidate regressions

Comparison keys prefer a page ID and otherwise use module, page number, and title

The runner does not declare a provider cheaper when cost entries are absent or only estimated; it reports the available micro-USD values and entry count

## Scope

This is a bounded offline evaluation slice, not a replacement for remote authentication, ReadWeave synchronization, provider probing, or end-to-end deployment tests
