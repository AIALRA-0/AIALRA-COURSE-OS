import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { normalizeLegacyMathDelimiters } from "@course-os/quality";

export { normalizeLegacyMathDelimiters } from "@course-os/quality";

export function Markdown({ children }: { children: string }) {
  const normalized = normalizeLegacyMathDelimiters(children);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[[rehypeKatex, { strict: "error", throwOnError: false, errorColor: "var(--red)" }]]}
      components={{
        img: () => null,
        a: ({ href, children: label }) => <a href={href} target="_blank" rel="noreferrer">{label}</a>,
        code: ({ children: code, className }) => <code className={className}>{code}</code>
      }}
    >
      {normalized}
    </ReactMarkdown>
  );
}
