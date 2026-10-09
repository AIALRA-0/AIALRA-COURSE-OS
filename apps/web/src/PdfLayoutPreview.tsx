import type { PdfLayoutInspection, PdfLayoutSelection, PdfPageLayoutMode } from "@course-os/contracts";
import "./studio-workbench.css";

export function PdfLayoutPreview({ inspection, selection, busy, error, onChange }: {
  inspection?: PdfLayoutInspection; selection: PdfLayoutSelection; busy: boolean; error: string;
  onChange: (value: PdfLayoutSelection) => void;
}) {
  return <section className="dialog-form pdf-layout-workbench" aria-labelledby="pdf-layout-preview-heading" aria-busy={busy}>
    <h3 id="pdf-layout-preview-heading">PDF 页面拆分预览</h3>
    <label className="pdf-layout-mode" data-action-slot="pdf-layout-mode"><span>PDF 页面处理</span><select data-action="pdf-layout-mode" value={selection.mode} disabled={busy}
      onChange={event => onChange({ mode: event.target.value as "auto" | "original" })}>
      <option value="auto">识别独立幻灯片，歧义页保留原页</option><option value="original">保留原始纸页</option>
    </select></label>
    {busy && <p className="pdf-layout-status" role="status" aria-live="polite">正在检查每页版式并准备预览，不会启动教学模型</p>}
    {error && <p className="pdf-layout-error" role="alert">{error} · 可以选择保留原页后重新检查</p>}
    {inspection && <>
      <div className="pdf-layout-summary"><strong>{inspection.physicalPageCount === inspection.logicalPageCount ? "原始页面" : "识别到双拼讲义"}：{inspection.physicalPageCount} 张纸页 → {inspection.logicalPageCount} 张页面</strong>
        <p>框线表示实际导入范围；确认导入后才执行转换。旧版本讲解和答案保持原关联。</p>
      </div>
      <div className="pdf-layout-previews" role="group" aria-label="页面拆分预览" data-action-slot="pdf-layout-previews">
        {inspection.previews.map(preview => <figure className="pdf-layout-preview-card" key={preview.physicalPage}>
          <img src={preview.imageDataUrl} alt={`第 ${preview.physicalPage} 张纸页拆分范围`} />
          <figcaption>原纸页 {preview.physicalPage}</figcaption>
        </figure>)}
      </div>
      <details><summary>逐页调整（只提供不会截断内容的方案）</summary>
        {inspection.pages.map(page => <label className="pdf-layout-page-choice" key={page.physicalPage}>
          <span>纸页 {page.physicalPage}{page.reason ? ` · ${page.reason}` : ""}</span>
          <select disabled={busy || selection.mode === "original"} value={selection.choices?.[String(page.physicalPage)] ?? page.mode}
            onChange={event => onChange({ mode: "auto", choices: { ...selection.choices, [page.physicalPage]: event.target.value as PdfPageLayoutMode } })}>
            {(page.options ?? ["original", page.mode]).filter((mode, index, modes) => modes.indexOf(mode) === index).map(mode =>
              <option key={mode} value={mode}>{mode === "original" ? "保留原页" : mode === "top-bottom" ? "上下双拼" : "左右双拼"}</option>)}
          </select>
        </label>)}
      </details>
    </>}
  </section>;
}
