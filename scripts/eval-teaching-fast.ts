import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareFastEvaluations, formatFastEvaluationMarkdown, loadEvaluationManifest, loadEvaluationSource, runFastEvaluation } from "./lib/eval-teaching-fast.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`MISSING_OPTION:${name}`);
  return value;
}

async function writeOrPrint(path: string | undefined, content: string): Promise<void> {
  if (path) await writeFile(resolve(path), content, "utf8");
  else process.stdout.write(content);
}

const manifest = await loadEvaluationManifest(requiredOption("--manifest"));
const baselinePath = option("--baseline");
const candidatePath = option("--candidate");
const inputPath = option("--input") ?? baselinePath;
if (!inputPath) throw new Error("MISSING_OPTION:--input or --baseline");

const baseline = baselinePath ? await runFastEvaluation(await loadEvaluationSource(baselinePath), manifest, "baseline") : undefined;
const candidate = candidatePath ? await runFastEvaluation(await loadEvaluationSource(candidatePath), manifest, "candidate") : undefined;
const result = candidate ?? baseline ?? await runFastEvaluation(await loadEvaluationSource(inputPath), manifest, "local");
const comparison = baseline && candidate ? compareFastEvaluations(baseline, candidate) : undefined;
const json = JSON.stringify(comparison ? { baseline, candidate, comparison } : result, null, 2) + "\n";
const markdown = formatFastEvaluationMarkdown(result, comparison);
await writeOrPrint(option("--json-out"), json);
if (!option("--json-out")) process.stderr.write(markdown);
else await writeOrPrint(option("--markdown-out"), markdown);

if ((result.status === "failed" || comparison?.regressions.length) && process.env.EVAL_TEACHING_FAST_ALLOW_FAILURE !== "1") process.exitCode = 1;
