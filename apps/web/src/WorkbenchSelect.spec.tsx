import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkbenchSelect, type WorkbenchSelectProps } from "./WorkbenchSelect.js";

type ChangeEventLike = { currentTarget: { value: string } };
type KeyEventLike = { key: string; stopPropagation: () => void; preventDefault: () => void };
type SelectElement = ReactElement<{
  onChange: (event: ChangeEventLike) => void;
  onKeyDown: (event: KeyEventLike) => void;
  disabled?: boolean;
}>;

function selectElement(props: WorkbenchSelectProps): SelectElement {
  const wrapper = WorkbenchSelect(props) as ReactElement<{ children: ReactElement[] }>;
  return wrapper.props.children[0] as SelectElement;
}

describe("WorkbenchSelect native behavior", () => {
  it("keeps one native select with the original controlled value and options", () => {
    const markup = renderToStaticMarkup(<WorkbenchSelect
      id="batch-size"
      value="3"
      options={[{ value: "2", label: "2 题" }, { value: "3", label: "3 题" }, { value: "5", label: "5 题" }]}
      onChange={() => {}}
      aria-describedby="batch-size-help"
    />);

    expect(markup.match(/<select\b/g)).toHaveLength(1);
    expect(markup).toContain('id="batch-size"');
    expect(markup).toContain('aria-describedby="batch-size-help"');
    expect(markup).toContain('data-icon-name="chevronDown"');
    expect(markup).toContain('<option value="3" selected="">3 题</option>');
    expect(markup).not.toContain('role="listbox"');
  });

  it("adapts native change events to the original string callback and ignores disabled changes", () => {
    const onChange = vi.fn();
    const enabled = selectElement({ value: "2", options: [{ value: "2", label: "2 题" }], onChange });
    enabled.props.onChange({ currentTarget: { value: "5" } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("5");

    const disabled = selectElement({ value: "2", options: [{ value: "2", label: "2 题" }], onChange, disabled: true });
    disabled.props.onChange({ currentTarget: { value: "5" } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("5");
    expect(disabled.props.disabled).toBe(true);
  });

  it("lets the browser handle native navigation and acceptance keys", () => {
    const select = selectElement({ value: "all", options: [{ value: "all", label: "全部" }], onChange: () => {} });
    const onKeyDown = select.props.onKeyDown;

    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "]) {
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();
      onKeyDown({ key, stopPropagation, preventDefault });
      expect(stopPropagation, key).not.toHaveBeenCalled();
      expect(preventDefault, key).not.toHaveBeenCalled();
    }
  });

  it("contains Escape within the select while preserving native cancellation", () => {
    const select = selectElement({ value: "all", options: [{ value: "all", label: "全部" }], onChange: () => {} });
    const onKeyDown = select.props.onKeyDown;
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();

    onKeyDown({ key: "Escape", stopPropagation, preventDefault });

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
