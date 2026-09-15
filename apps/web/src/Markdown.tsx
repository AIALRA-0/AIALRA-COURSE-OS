import ReactMarkdown from "react-markdown";
import type { ReactNode } from "react";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import { normalizeLegacyMathDelimiters } from "@course-os/quality";

export { normalizeLegacyMathDelimiters } from "@course-os/quality";

export function Markdown({ children, nestedHeadings = false, inline = false }: { children: string; nestedHeadings?: boolean; inline?: boolean }) {
  const normalized = normalizeLegacyMathDelimiters(children);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkGfm]}
      rehypePlugins={[[rehypeKatex, { strict: "error", throwOnError: false, errorColor: "var(--red)" }]]}
      components={{
        ...(nestedHeadings ? {
          h1: ({ children: label }: { children?: ReactNode }) => <h4>{label}</h4>,
          h2: ({ children: label }: { children?: ReactNode }) => <h4>{label}</h4>,
          h3: ({ children: label }: { children?: ReactNode }) => <h5>{label}</h5>,
          h4: ({ children: label }: { children?: ReactNode }) => <h6>{label}</h6>
        } : {}),
        ...(inline ? { p: ({ children: text }) => <span>{text}</span> } : {}),
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
