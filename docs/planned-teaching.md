# Planned teaching

The production provider adapter uses a source-grounded plan followed by three bounded writing calls. Previous-page context comes from generated lesson sections in the same workspace and release, preferring a ready draft. It never requests the previous slide image or substitutes extracted slide text for previously taught knowledge.

## Construction

1. `page-plan-prompt.md` reads the current image and source objects once. It assigns facts to ordered teaching steps, identifies required prerequisites, and connects approachable objectives to questions.
2. `planned-writing-prompt.md` writes the bridge, prerequisites and objectives.
3. The explanation call receives that actual opening as context, the plan and source facts. Previously defined concepts are applied rather than defined again.
4. The final call receives a bounded, whole-paragraph extract of the explanation plus the opening. It produces the summary, misconceptions and four questions.

The writing policy is the versioned `policy-format-rules.md`. Content responsibilities belong to the teaching plan. Course-specific repair instructions are not sent by this path. Legacy direct clients retain their old response compatibility.

## Checks and cost

The local validator verifies schemas, known source IDs, complete fact assignment, backward-only dependencies, objective/question links, exact evidence quotations, math parsing and answer options. These checks establish structural correctness, not proof that a reader understands the lesson. Different real slides must also be read and checked against their images.

Only one partial-stage repair is permitted per page. Preceding stages are not regenerated. The provider and model remain fixed throughout one page. Each request is bounded against the remaining page budget using the configured price snapshot; actual or estimated usage is accumulated, including failed calls. The current ceiling remains USD 0.06, a budget in USD rather than a guaranteed live currency conversion.

Planned DeepSeek calls explicitly enable reasoning instead of inheriting the legacy transport's disabled setting. Output limits include reasoning tokens; those tokens count toward cost, while hidden reasoning text is neither saved nor shown. Source fidelity constrains meaning, not the use of untranslated labels in learner prose. Imported image labels are locators; actual observed image content receives its own coverage claim.

`teachingTrace` persists the actual plan, preceding-page context and phase receipts inside the private lesson data. The public inspection endpoint shows the active prompts. Existing task leases, snapshot pinning, readback hashes and immutable releases remain in force.

## Review cases

Use at least one numerical/formula slide, one comparison/table slide and one diagram/process slide. Check whether the opening uses prior teaching, objectives are understandable before the main explanation, source objects remain covered, and summary/questions introduce no new claims. Evidence must include actual model, phase usage and the reader-visible page, not only a simulated provider test.
