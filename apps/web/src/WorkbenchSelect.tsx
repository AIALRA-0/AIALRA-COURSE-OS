import type { KeyboardEvent } from "react";
import { Icon } from "./Icon.js";
import "./WorkbenchSelect.css";

export type WorkbenchSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type WorkbenchSelectProps = {
  id?: string;
  name?: string;
  value: string;
  options: readonly WorkbenchSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "data-action"?: string;
};

/** Native select semantics keep browser keyboard exploration, commit, cancel, and listbox accessibility. */
export function WorkbenchSelect({
  id,
  name,
  value,
  options,
  onChange,
  disabled = false,
  required = false,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "data-action": dataAction,
}: WorkbenchSelectProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLSelectElement>) => {
    // Keep Escape's native cancellation while preventing an enclosing dialog from closing.
    if (event.key === "Escape") event.stopPropagation();
  };

  return <span className="workbench-select-shell">
    <select
      id={id}
      name={name}
      className={["workbench-select", className].filter(Boolean).join(" ")}
      value={value}
      disabled={disabled}
      required={required}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      data-action={dataAction}
      onChange={(event) => { if (!disabled) onChange(event.currentTarget.value); }}
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>
    <Icon name="chevronDown" className="workbench-select-chevron" />
  </span>;
}
