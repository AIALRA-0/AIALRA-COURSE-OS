import { useId } from "react";
import { Markdown } from "./Markdown.js";
import { questionOptionLabel, type QuestionBatchSize } from "./question-preview.js";

/** Changes only the requested next batch, never the currently saved selection. */
export function QuestionBatchControls({ requestedCount, actualCount, pending, onChange }: {
  requestedCount: QuestionBatchSize; actualCount: number; pending: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return <div className="question-batch-controls">
    <div className="question-batch-field">
      <label className="question-batch-size" htmlFor={id}>
        <span>下一组题数</span>
        <select id={id} value={requestedCount} onChange={event => onChange(event.target.value)}
          disabled={pending} aria-describedby={`${id}-help`}>
          <option value={2}>2 题</option><option value={3}>3 题</option><option value={5}>5 题</option>
        </select>
      </label>
      <small id={`${id}-help`}>点击“换一组题”后生效，不改变当前作答。</small>
    </div>
    <span className="question-batch-actual">本组 <strong>{actualCount}</strong> 题</span>
  </div>;
}

/** Native exclusive-choice semantics and original saved answer values are retained. */
export function QuestionChoiceList({ name, options, answer, disabled, labelledBy, onChange }: {
  name: string; options: string[]; answer: string | undefined; disabled: boolean;
  labelledBy?: string;
  onChange: (value: string) => void;
}) {
  return <fieldset className="choice-list" disabled={disabled} aria-labelledby={labelledBy}>
    <legend className="sr-only">请选择一个答案</legend>
    {options.map((option, index) => <label key={`${name}:${index}`}>
      <input type="radio" name={name} value={option} checked={answer === option}
        disabled={disabled} onChange={event => onChange(event.target.value)} />
      <span className="choice-label">{questionOptionLabel(index)}</span>
      <span className="choice-copy"><Markdown inline>{option}</Markdown></span>
    </label>)}
  </fieldset>;
}
