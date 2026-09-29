import { spawn } from "node:child_process";

/** Spatial hints for code reading, not coverage obligations or a second parser. */
export function codeLayoutHint(tsv: string): string {
  const lines = new Map<string, { top: number; words: Array<{ left: number; text: string }> }>();
  for (const row of tsv.split(/\r?\n/u).slice(1)) {
    const cells = row.split("\t");
    if (cells[0] !== "5" || !cells[11]?.trim()) continue;
    const left = Number(cells[6]);
    const top = Number(cells[7]);
    if (!Number.isFinite(left) || !Number.isFinite(top) || Number(cells[10]) < 0) continue;
    const key = cells.slice(1, 5).join(":");
    const line = lines.get(key) ?? { top, words: [] };
    line.words.push({ left, text: cells[11]!.trim() });
    lines.set(key, line);
  }
  const ordered = [...lines.values()].sort((a, b) => a.top - b.top);
  const text = ordered.map(line => line.words.map(word => word.text).join(" ")).join("\n");
  if ((text.match(/\b(?:while|for|if|begin|end)\b/giu) ?? []).length < 3) return "";
  const positioned = ordered.map(line => {
      const first = line.words.find(word => /[\p{L}\p{N}]/u.test(word.text)) ?? line.words[0]!;
      return { left: first.left, text: line.words.map(word => word.text).join(" ") };
    });
  const origin = Math.min(...positioned.map(line => line.left));
  // Preserve geometry as whitespace too: this is a layout aid, not inferred syntax.
  const layout = positioned.map(line => " ".repeat(Math.min(100, Math.round((line.left - origin) / 10))) + line.text).join("\n");
  return ("原图代码位置参考：x 是每行首个文字在原图中的横向像素位置，只用于核对缩进；OCR 字符可能错读，文字与符号仍以原图为准，不把位置数字写入讲解\n"
    + positioned.map(line => `x=${line.left} ${line.text}`).join("\n")
    + "\n\n按横向位置还原的排版参考（未推断语法，字符按原图核对）：\n```text\n" + layout + "\n```\n同一横向位置表示同层；退回较小横向位置的语句已退出之前的深层块，不能重新缩进到该块内。").slice(0, 12_000);
}

/** Optional source hint; failure must not block the existing visual reader. */
export async function readCodeLayoutHint(imageDataUrl: string): Promise<string> {
  const encoded = /^data:image\/[a-z+.-]+;base64,(.+)$/isu.exec(imageDataUrl)?.[1];
  if (!encoded) return "";
  return new Promise(resolve => {
    const child = spawn(process.env.COURSE_OS_OCR_BIN || "tesseract", ["stdin", "stdout", "--psm", "6", "tsv"], {
      env: { ...process.env, OMP_THREAD_LIMIT: "1" }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true
    });
    let output = "";
    let settled = false;
    const finish = (hint: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(hint);
    };
    const timer = setTimeout(() => { child.kill(); finish(""); }, 8_000);
    child.on("error", () => finish(""));
    child.stdin.on("error", () => { child.kill(); finish(""); });
    child.stdout.on("data", chunk => {
      output += chunk.toString("utf8");
      if (output.length > 1_000_000) { child.kill(); finish(""); }
    });
    child.on("close", code => finish(code === 0 ? codeLayoutHint(output) : ""));
    child.stdin.end(Buffer.from(encoded, "base64"));
  });
}
