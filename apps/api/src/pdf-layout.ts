import type { PdfLayoutSelection } from "@course-os/contracts";

/** Clients select layout modes, never supply trusted crop coordinates. */
export function parsePdfLayout(value: unknown): PdfLayoutSelection | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PDF_LAYOUT_INVALID");
  const input = parsed as Record<string, unknown>;
  if (input.mode !== "auto" && input.mode !== "original") throw new Error("PDF_LAYOUT_INVALID");
  const choices: PdfLayoutSelection["choices"] = {};
  if (input.choices !== undefined) {
    if (!input.choices || typeof input.choices !== "object" || Array.isArray(input.choices)) throw new Error("PDF_LAYOUT_INVALID");
    for (const [page, mode] of Object.entries(input.choices)) {
      if (!/^[1-9]\d{0,2}$/.test(page) || Number(page) > 500 || !["original", "top-bottom", "left-right"].includes(String(mode))) throw new Error("PDF_LAYOUT_INVALID");
      choices[page] = mode as NonNullable<PdfLayoutSelection["choices"]>[string];
    }
  }
  if (Object.keys(choices).length > 500) throw new Error("PDF_LAYOUT_INVALID");
  return { mode: input.mode, ...(Object.keys(choices).length ? { choices } : {}) };
}
