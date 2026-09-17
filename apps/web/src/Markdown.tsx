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

export function Markdown({ children, nestedHeadings = false, inline = false }: { children: string; nestedHeadings?: boolean; inline?: boolean }) {
  const withMath = normalizeLegacyMathDelimiters(children);
  const normalized = inline ? withMath : normalizeStandaloneMathBlocks(withMath);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkGfm]}
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
