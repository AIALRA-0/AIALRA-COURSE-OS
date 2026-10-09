import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionBatchControls, QuestionChoiceList } from "./QuestionInputs.js";

describe("quiz presentation does not change saved answers", () => {
  it("has no checked radio before selection", () => {
    const html = renderToStaticMarkup(<QuestionChoiceList name="stable-question-key" options={["alpha", "beta"]} answer={undefined} disabled={false} onChange={() => {}} />);
    expect(html).not.toContain(' checked=""');
    expect(html.match(/type="radio"/g)?.length).toBe(2);
    expect(html).toContain("请选择一个答案");
  });
  it("retains exactly the saved option value", () => {
    const html = renderToStaticMarkup(<QuestionChoiceList name="stable-question-key" options={["alpha", "beta"]} answer="beta" disabled={false} onChange={() => {}} />);
    expect(html.match(/checked=""/g)?.length).toBe(1);
    expect(html).toContain('value="beta"');
    expect(html.match(/name="stable-question-key"/g)?.length).toBe(2);
  });
  it("keeps the original option value even when the visible choice label is different", () => {
    const html = renderToStaticMarkup(<QuestionChoiceList name="stable-question-key" options={["Correct & exact", "Another <choice>"]} answer="Correct & exact" disabled={false} onChange={() => {}} />);

    expect(html).toContain('checked="" value="Correct &amp; exact"');
    expect(html).toContain('value="Another &lt;choice&gt;"');
    expect(html).toContain('<span class="choice-label">A.</span>');
    expect(html).toContain('<span class="choice-copy"><span>Correct &amp; exact</span></span>');
  });
  it("disables the whole exclusive-choice group while its answer is pending", () => {
    const html = renderToStaticMarkup(<QuestionChoiceList name="stable-question-key" options={["alpha", "beta"]} answer="alpha" disabled onChange={() => {}} />);

    expect(html).toContain('<fieldset class="choice-list workbench-choice-list study-question-choice-list" disabled="">');
    expect(html.match(/type="radio"[^>]*disabled=""/g)).toHaveLength(2);
  });
  it("keeps actual and requested batch sizes separate", () => {
    const html = renderToStaticMarkup(<QuestionBatchControls requestedCount={5} actualCount={3} pending={true} onChange={() => {}} />);
    expect(html).toContain('value="5" selected=""');
    expect(html).toContain('<strong>3</strong>');
    expect(html).toContain("不改变当前作答");
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('class="question-batch-controls workbench-control-row study-question-batch"');
  });
  it("associates the batch-size label and explanation with its select", () => {
    const html = renderToStaticMarkup(<QuestionBatchControls requestedCount={3} actualCount={2} pending={false} onChange={() => {}} />);
    const id = html.match(/<select id="([^"]+)"/)?.[1];

    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
    expect(html).toContain(`aria-describedby="${id}-help"`);
    expect(html).toContain(`id="${id}-help"`);
  });
  it("associates the choice group with its question heading", () => {
    const html = renderToStaticMarkup(<QuestionChoiceList name="stable-question-key" options={["alpha", "beta"]} answer={undefined} disabled={false} labelledBy="question-heading" onChange={() => {}} />);

    expect(html).toContain('aria-labelledby="question-heading"');
  });
});
