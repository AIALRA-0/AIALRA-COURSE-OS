/** Flatten only explicit definition boundaries; prose punctuation is never a separator. */
export function parsePriorKnowledgeDefinitions(input: string | readonly string[]): string[] {
  const result: Array<{ text: string; definition: boolean }> = [];
  for (const source of typeof input === "string" ? [input] : input) {
    let lines: string[] = [];
    let definition = false;
    let fence: { marker: string; length: number } | undefined;
    let math: string | undefined;
    let inline: string | undefined;
    let listIndent: number | undefined;
    const flush = () => {
      const text = definition ? continuousDefinition(lines) : lines.join("\n").trim();
      if (text) {
        const previous = result.at(-1);
        if (!definition && previous?.definition && isContinuation(text)) {
          previous.text = continuousDefinition([previous.text, text]);
        } else result.push({ text, definition });
      }
      lines = [];
      definition = false;
      listIndent = undefined;
    };
    for (const line of source.split(/\r?\n/u)) {
      const trimmed = line.trimStart();
      if (fence) {
        lines.push(line);
        const close = /^(?:`{3,}|~{3,})\s*$/u.exec(trimmed);
        if (close && close[0].trim()[0] === fence.marker && close[0].trim().length >= fence.length) fence = undefined;
        continue;
      }
      if (math) {
        lines.push(line);
        if (trimmed.includes(math)) math = undefined;
        continue;
      }
      if (inline) {
        lines.push(line);
        inline = unfinishedInline(line, inline);
        continue;
      }
      // Block quotes and indented code are opaque, including any term-shaped text inside them.
      if (/^(?:>| {4}|\t)/u.test(line)) { lines.push(line); continue; }
      const open = /^(`{3,}|~{3,})(.*)$/u.exec(trimmed);
      if (open) { fence = { marker: open[1]![0]!, length: open[1]!.length }; lines.push(line); continue; }
      const display = /^(\$\$|\\\[)/u.exec(trimmed);
      if (display) {
        const closer = display[1] === "$$" ? "$$" : "\\]";
        if (!trimmed.slice(display[1]!.length).includes(closer)) math = closer;
        lines.push(line);
        continue;
      }
      const bullet = /^( *)(?:[-+*]|\d+[.)])\s+(.+)$/u.exec(line);
      const indent = bullet?.[1]?.length ?? 0;
      const body = bullet ? bullet[2]! : trimmed;
      const heading = /^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/u.exec(body);
      const label = heading ? heading[1]!.trim() : undefined;
      const explicit = label ? isTermLabel(label, true) : isDefinition(body);
      // A genuine sublist remains attached to its definition instead of being promoted.
      const nested = bullet && listIndent !== undefined && indent > listIndent;
      if (explicit && !nested) {
        flush();
        definition = true;
        lines.push(label ? `${label.replace(/[：:]$/u, "")}：` : body);
      } else if (bullet && definition && !nested && isContinuation(body)) {
        lines.push(body);
      } else lines.push(line);
      if (bullet) listIndent = Math.min(listIndent ?? indent, indent);
      inline = unfinishedInline(line);
    }
    flush();
  }
  return result.map(({ text }) => text);
}

function isContinuation(text: string): boolean {
  return /^(?:它(?:们)?(?:的|工作)|其(?:作用|用途|工作|原理)|该(?:方法|机制|过程|概念|函数)(?:的|通过)|需要区分的是|具体来说|例如[：:]|也就是说|换言之)/u.test(text.trimStart());
}

function isTermLabel(value: string, explicit = false): boolean {
  const label = value.replace(/^\*\*|\*\*$/gu, "").replace(/[：:]$/u, "").trim();
  const outsideParentheses = label.replace(/[（(][^）)]*[）)]/gu, "");
  if (!label || label.length > 100 || isContinuation(label)
    || /[。；;!?！？：:$`<>\[\]{}]/u.test(label) || /[，,]/u.test(outsideParentheses)) return false;
  if (explicit) return /^[\p{L}\p{N} ,，()（）_./+–—-]+$/u.test(label);
  // Unformatted labels require an identifier or bilingual shape, not an arbitrary clause before a colon.
  return /^[A-Za-z][\w./+–—-]*$/u.test(label)
    || /^[\p{L}\p{N} _./+–—-]+[（(][\p{L}\p{N} ,，_./+–—-]+[）)]$/u.test(label);
}

function isDefinition(text: string): boolean {
  const bold = /^\*\*([^*\r\n]+?)[：:][ \t]*\*\*|^\*\*([^*\r\n]+?)\*\*[ \t]*[：:]/u.exec(text);
  if (bold) return isTermLabel(bold[1] ?? bold[2]!, true);
  const plain = /^([^：:\r\n]+)[：:]/u.exec(text);
  return Boolean(plain && isTermLabel(plain[1]!));
}

/** Track multiline inline code/math so a apparent list item inside it is not a boundary. */
function unfinishedInline(line: string, pending?: string): string | undefined {
  for (let i = 0; i < line.length; i++) {
    if (pending) {
      if (line.startsWith(pending, i)) { i += pending.length - 1; pending = undefined; }
      else if (line[i] === "\\") i++;
    } else if (line.startsWith("\\(", i)) {
      pending = "\\)";
      i++;
    } else if (line[i] === "\\") {
      i++;
    } else if (line[i] === "`") {
      pending = /^`+/u.exec(line.slice(i))![0];
      i += pending.length - 1;
    } else if (line[i] === "$") pending = "$";
  }
  return pending;
}

/** Ordinary definition prose stays one block; Markdown block objects remain opaque. */
function continuousDefinition(lines: readonly string[]): string {
  const result: string[] = [];
  let prose: string[] = [];
  let fence: string | undefined;
  let math: string | undefined;
  let inline: string | undefined;
  const flush = () => { if (prose.length) result.push(prose.join(" ")); prose = []; };
  for (const line of lines.flatMap(value => value.split("\n"))) {
    const trimmed = line.trim();
    if (fence || math || inline) {
      result.push(line);
      if (fence && new RegExp(`^${fence[0]}{${fence.length},}\\s*$`, "u").test(trimmed)) fence = undefined;
      else if (math && trimmed.includes(math)) math = undefined;
      else if (inline) inline = unfinishedInline(line, inline);
      continue;
    }
    const open = /^(?:`{3,}|~{3,})/u.exec(trimmed);
    const display = /^(\$\$|\\\[)/u.exec(trimmed);
    const block = /^(?:\s*>| {4}|\t|\s*[-+*]\s|\s*\d+[.)]\s|\s*#{1,6}\s|\s*\||\s*(?:---+|\*\*\*+)\s*$)/u.test(line);
    if (open || display || block) {
      flush();
      result.push(line);
      if (open) fence = open[0];
      if (display) {
        const closer = display[1] === "$$" ? "$$" : "\\]";
        if (!trimmed.slice(display[1]!.length).includes(closer)) math = closer;
      }
    } else if (trimmed) {
      if (result.length && !prose.length && result.at(-1) !== "") result.push("");
      inline = unfinishedInline(line);
      if (inline) { flush(); result.push(line); }
      else prose.push(trimmed);
    } else if (!prose.length && result.at(-1) !== "") result.push("");
  }
  flush();
  return result.join("\n").trim();
}
