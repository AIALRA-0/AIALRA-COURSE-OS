import { useId } from "react";
import { Markdown } from "./Markdown.js";
import { WorkbenchSelect } from "./WorkbenchSelect.js";
import { questionOptionLabel, type QuestionBatchSize } from "./question-preview.js";
import "./study-workbench.css";

/** Changes only the requested next batch, never the currently saved selection. */
export function QuestionBatchControls({ requestedCount, actualCount, pending, onChange }: {
  requestedCount: QuestionBatchSize; actualCount: number; pending: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return <div className="question-batch-controls workbench-control-row study-question-batch" aria-busy={pending}>
    <div className="question-batch-field study-question-batch-field">
      <label className="question-batch-size" htmlFor={id}>
        <span>下一组题数</span>
        <WorkbenchSelect id={id} value={String(requestedCount)} onChange={onChange}
          disabled={pending} aria-describedby={`${id}-help`} options={[
            { value: "2", label: "2 题" }, { value: "3", label: "3 题" }, { value: "5", label: "5 题" }
          ]} />
      </label>
      <small id={`${id}-help`}>点击“换一组题”后生效，不改变当前作答。</small>
    </div>
    <span className="question-batch-actual workbench-status study-question-batch-actual" role="status" aria-live="polite">本组 <strong>{actualCount}</strong> 题</span>
  </div>;
}

/** Native exclusive-choice semantics and original saved answer values are retained. */
export function QuestionChoiceList({ name, options, answer, disabled, labelledBy, onChange }: {
  name: string; options: string[]; answer: string | undefined; disabled: boolean;
  labelledBy?: string;
  onChange: (value: string) => void;
}) {
  return <fieldset className="choice-list workbench-choice-list study-question-choice-list" disabled={disabled} aria-labelledby={labelledBy}>
    <legend className="sr-only">请选择一个答案</legend>
    {options.map((option, index) => <label key={`${name}:${index}`}>
      <input type="radio" name={name} value={option} checked={answer === option}
        disabled={disabled} onChange={event => onChange(event.target.value)} />
      <span className="choice-label">{questionOptionLabel(index)}</span>
      <span className="choice-copy"><Markdown inline>{option}</Markdown></span>
    </label>)}
  </fieldset>;
}
