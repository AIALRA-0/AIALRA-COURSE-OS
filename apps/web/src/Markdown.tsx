import ReactMarkdown from "react-markdown";
import type { ReactNode } from "react";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import { normalizeLegacyMathDelimiters } from "@course-os/quality";

export { normalizeLegacyMathDelimiters } from "@course-os/quality";

/** A formula occupying its own line is a displayed object, not inline prose. */
export function normalizeStandaloneMathBlocks(source: string): string {
  let inFence = false;
  return source.split(/\r?\n/u).map(line => {
    if (/^\s*(?:```|~~~)/u.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    const match = /^\s*\$([^$\n]+)\$\s*$/u.exec(line);
    if (!match || !/(?:=|\\(?:sum|frac|int|prod|left|right))/u.test(match[1]!)) return line;
    return `\n$$\n${match[1]}\n$$\n`;
  }).join("\n");
}

const escapedMathPipe = "COURSEOSMATHPIPEPLACEHOLDER";

/** Keep GFM table separators inside inline math opaque until remark-math has parsed the cell. */
function protectInlineMathPipes(source: string): string {
  let inFence = false;
  return source.split(/(\r?\n)/u).map((part) => {
    if (/^\r?\n$/u.test(part)) return part;
    if (/^\s*(?:```|~~~)/u.test(part)) { inFence = !inFence; return part; }
    if (inFence) return part;
    let result = "";
    let index = 0;
    while (index < part.length) {
      if (part[index] === "`") {
        const run = /^`+/u.exec(part.slice(index))?.[0] || "`";
        const end = part.indexOf(run, index + run.length);
        if (end >= 0) { result += part.slice(index, end + run.length); index = end + run.length; continue; }
      }
      const delimiter = part.startsWith("\\(", index) ? "\\)"
        : part.startsWith("$$", index) ? "$$"
        : part[index] === "$" ? "$" : undefined;
      if (!delimiter || (delimiter === "$" && (part.startsWith("$$", index) || (index > 0 && part[index - 1] === "\\")))) {
        result += part[index];
        index += 1;
        continue;
      }
      const contentStart = index + (delimiter === "\\)" ? 2 : delimiter.length);
      const close = part.indexOf(delimiter, contentStart);
      if (close < 0) { result += part[index]; index += 1; continue; }
      const content = part.slice(contentStart, close).replace(/(?<!\\)\|/gu, escapedMathPipe);
      result += part.slice(index, contentStart) + content + delimiter;
      index = close + delimiter.length;
    }
    return result;
  }).join("");
}

function restoreInlineMathPipes() {
  return (tree: { children?: Array<{ type?: string; value?: string; children?: unknown[] }> }) => {
    const visit = (node: { type?: string; value?: string; children?: unknown[] }) => {
      if ((node.type === "inlineMath" || node.type === "math") && typeof node.value === "string") {
        node.value = node.value.replaceAll(escapedMathPipe, "|");
      }
      node.children?.forEach((child) => {
        if (child && typeof child === "object") visit(child as { type?: string; value?: string; children?: unknown[] });
      });
    };
    tree.children?.forEach(visit);
  };
}

export function Markdown({ children, nestedHeadings = false, inline = false }: { children: string; nestedHeadings?: boolean; inline?: boolean }) {
  const withMath = protectInlineMathPipes(normalizeLegacyMathDelimiters(children));
  const normalized = inline ? withMath : normalizeStandaloneMathBlocks(withMath);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkGfm, restoreInlineMathPipes]}
      rehypePlugins={[[rehypeKatex, { strict: "error", throwOnError: false, errorColor: "var(--red)" }]]}
      components={{
        ...(nestedHeadings ? {
          h1: ({ children: label }: { children?: ReactNode }) => <h4>{label}</h4>,
          h2: ({ children: label }: { children?: ReactNode }) => <h4>{label}</h4>,
          h3: ({ children: label }: { children?: ReactNode }) => <h5>{label}</h5>,
          h4: ({ children: label }: { children?: ReactNode }) => <h6>{label}</h6>,
          h5: ({ children: label }: { children?: ReactNode }) => <h6>{label}</h6>,
          h6: ({ children: label }: { children?: ReactNode }) => <h6>{label}</h6>
        } : {}),
        p: ({ node, children: text }) => {
          if (inline) return <span>{text}</span>;
          const visible = (node?.children ?? []).filter(child => child.type !== "text" || child.value.trim());
          const mathOnly = visible.length === 1 && visible[0]?.type === "element"
            && visible[0].tagName === "span" && (visible[0].properties.className as string[] | undefined)?.includes("katex");
          return <p className={mathOnly ? "math-only-paragraph" : undefined}>{text}</p>;
        },
        table: ({ children: rows }) => <div className="lesson-table-scroll"><table>{rows}</table></div>,
        img: () => null,
        a: ({ href, children: label }) => <a href={href} target="_blank" rel="noreferrer">{label}</a>,
        code: ({ children: code, className }) => <code className={className}>{code}</code>
      }}
    >
      {normalized}
    </ReactMarkdown>
  );
}
