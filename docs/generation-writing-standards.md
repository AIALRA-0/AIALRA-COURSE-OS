# 1. Generation writing standards

Course OS uses the installed APCF Writing 1–29 and Style S00–S14 standards for newly generated teaching text, with Chinese-specific rules scoped to Chinese prose. The standards are not inherited implicitly from an Agent's `AGENTS.md`; they are verified and included at the provider request boundary.

## 1.1. Source and distribution

`scripts/sync-writing-standards.ts` imports the two public standards pinned by the installed APCF `standards/LOCK.yaml`. The distributed `writing-standard-source.md` and `style-standard-source.md` retain those exact bytes, including line endings. They are generated copies, not a second editable authority. Update the installed standards and lock first, then run:

```sh
pnpm exec tsx scripts/sync-writing-standards.ts
pnpm exec tsx scripts/sync-writing-standards.ts --check
pnpm verify:writing
```

A clean public checkout only needs `--check`; APCF's private execution history is not required to build or run the application. Prior policy manifests remain in `config/writing-policy-snapshots` so saved courses and answers retain their original revision associations.

## 1.2. Requests and applicability

The compiler keeps every normative paragraph in all 44 sections, including principles, triggers, obligations, exceptions and stopping conditions. It removes only Bad/Good demonstrations. Runtime validation rejects missing files, mismatched hashes, incomplete rule coverage and an inconsistent policy manifest before submitting a generation request. Responses, Messages and Chat Completions transports share this boundary, including configured fallbacks.

Page understanding, planning, complete teaching, the existing single local format repair, and the later bridge receive the applicable policy. Fixed JSON keys, literal source material, original code, mathematical notation and the seven teaching sections remain protected. Product-specific requirements, including explaining symbols at each formula, take precedence over general shorthand exceptions. The policy does not add generation stages, semantic scoring gates or content repair loops.

Saved quiz explanations also supply answer feedback and review explanations. Random selection does not call a model. Existing hints and deterministic question-refill templates are separate code paths; policy delivery to the model does not magically rewrite those templates or historical course content.

## 1.3. What tests establish

Request-capture tests establish that the current verified rules reached all supported transports and generation phases. Real isolated samples establish only the observed quality of those outputs. Neither a hash nor a structural test proves universal semantic compliance. Review source fidelity, terminology, definitions, mathematical steps, code execution, repetition and tone against the applicable rules before declaring an output satisfactory.

The full policy consumes input tokens. Existing cost ceilings and provider error handling remain active; an insufficient budget must fail explicitly rather than silently omit rules or raise the ceiling. Do not present a truncated or failed provider output as a completed lesson.
