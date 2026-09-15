import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TeachingBlueprint } from "@course-os/contracts";

const harnessDir = resolve(fileURLToPath(new URL("../../../config/generation-harness/", import.meta.url)));
const apiSourceDir = resolve(fileURLToPath(new URL("../../../apps/api/src/", import.meta.url)));
const readHarnessFile = (name: string): string => readFileSync(resolve(harnessDir, name), "utf8");
export const teachingSystemPromptTemplate = readHarnessFile("teaching-system-prompt.md");
export const teachingUserPromptTemplate = readHarnessFile("teaching-user-prompt.md");
export const teachingBlueprint = readHarnessFile("teaching-blueprint.md");
export const semanticAuditPrompt = readHarnessFile("semantic-audit-prompt.md");
export const policyFormatRules = readHarnessFile("policy-format-rules.md");
export const policyExplanationFramework = readHarnessFile("policy-explanation-framework.md");
export const policyFormulaExplanation = readHarnessFile("policy-formula-explanation.md");
export const teachingPackageSchema = JSON.parse(readHarnessFile("teaching-package.schema.json")) as Record<string, unknown>;
export const semanticAuditSchema = JSON.parse(readHarnessFile("semantic-audit.schema.json")) as Record<string, unknown>;
const harnessManifest = JSON.parse(readHarnessFile("harness-manifest.json")) as { id: string; version: string; taskContract: "GENERATE + TEACHING" };

export interface PromptInput {
  pageTitle: string;
  pageNumber: number;
  sourceText: string;
  sourceImageDataUrl?: string;
  writingPolicySnapshotId: string;
  language?: string;
  qualityMode?: string;
  blueprint?: TeachingBlueprint;
  previousPageContext?: string;
  repair?: {
    issues: string[];
    maximumExplanationCharacters: number;
    previousTeachingPackage: {
      learningObjectives: string[];
      mainContentMarkdown: string;
      priorKnowledge: string[];
      fullExplanationMarkdown: string;
      misconceptions: string[];
      coverageEvidence: Array<{ atomId: string; coveredFields: string[]; explanation: string }>;
      questions: Array<{ kind: "comprehension" | "multiple_choice"; prompt: string; options?: string[]; expectedAnswer: string; explanation: string }>;
    };
  };
}

export interface GenerationHarnessSnapshot {
  id: string;
  version: string;
  taskContract: "GENERATE + TEACHING";
  files: Array<{ path: string; sha256: string }>;
  aggregateSha256: string;
}

const targetLanguage = (language: string): string => language === "en" ? "English" : "简体中文";
const render = (template: string, values: Record<string, string>): string => Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template);

export function professorInstructions(language: string): string {
  const systemPrompt = render(teachingSystemPromptTemplate, { LANGUAGE: targetLanguage(language) }).trim();
  if (language === "en") return systemPrompt;
  return `${systemPrompt}\n\n---\n\n${policyFormatRules.trim()}\n\n---\n\n${policyExplanationFramework.trim()}\n\n---\n\n${policyFormulaExplanation.trim()}`;
}

export function modelInput(input: PromptInput): string | Array<{ role: "user"; content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "high" }> }> {
  const text = render(teachingUserPromptTemplate, {
    WRITING_POLICY_SNAPSHOT_ID: input.writingPolicySnapshotId,
    LANGUAGE: targetLanguage(input.language || "zh-CN"),
    QUALITY_MODE: input.qualityMode || "balanced",
    PAGE_NUMBER: String(input.pageNumber),
    PAGE_TITLE: input.pageTitle,
    SOURCE_TEXT: input.sourceText.slice(0, 45_000),
    PREVIOUS_PAGE_CONTEXT: input.previousPageContext?.slice(0, 2_000) || "未提供可靠的前页来源；不要编写前页或上一章回顾"
  }).trim();
  // Source atoms and requirements already appear in SOURCE_TEXT. Send only the
  // decisions the blueprint adds, rather than a second copy of the source.
  const blueprintText = input.blueprint ? `\n\n## 本页讲解安排\n${JSON.stringify({
    pageKind: input.blueprint.resourcePackage.pageKind,
    sourceDensity: input.blueprint.resourcePackage.sourceDensity,
    imageAvailable: input.blueprint.resourcePackage.imageAvailable,
    steps: input.blueprint.steps.map(({ kind, objective, required }) => ({ kind, objective, required }))
  })}` : "";
  const repairText = input.repair ? [
    "\n\n## 局部修复任务",
    "下面的对象是上一轮模型草稿，不是 SOURCE，不能用它替代原始课件",
    input.repair.issues.includes("TEACHING_SEMANTIC_CROSSCHECK")
      ? "独立核对上一轮草稿与原图、提取文字和自身各字段的语义一致性；这不是润色任务"
      : `只修复这些已验证问题：${input.repair.issues.join("、")}`,
    ...(input.repair.issues.includes("TEACHING_SEMANTIC_CROSSCHECK") ? ["逐式复算所有数值关系，分别辨认原始量、比值、裁剪或归一化后的量、目标值与损失；同一个量在完整讲解、易错点、总结和题目中必须保持同一含义。逐一核对图表横纵轴、图例、比较对象和来源边界，不把指标名称相近当成同一个量。发现矛盾时只改错误断言及受影响的答案；没有错误时保持原文。不得为了通过检查补造来源之外的事实；只返回完整 TeachingPackage JSON，不把核验过程写进学习正文"] : []),
    ...(input.repair.issues.includes("TEACHING_SOURCE_CLAIM_REPAIR") ? ["来源核验列出的 contradicted 主张须按原图更正，unverified 主张须删除或改成仅描述图上确实可见的对象与位置；不得把位置、相邻关系或相同标签推成同一智能体、动作先后、回报来源或系数用途。先改完整讲解，再同步改总结、易错点和题目答案，最后从新正文逐字填写 coverageEvidence。保留其他已核实的教学内容，不得把核验标签写进正文"] : []),
    ...(input.repair.issues.some((issue) => issue.startsWith("TEACHING_WEIGHTED_TREND_CONDITION_MISSING:")) ? ["含符号权重的公式不能仅凭负号推出无条件单调性。只修改被指出的字段：逐项核对权重符号、其他输入保持不变的条件；来源未给取值范围时改为明确条件句，不新增未经证实的权重取值，也不改变原公式"] : []),
    ...(input.repair.issues.some((issue) => issue.startsWith("TEACHING_REWARD_DIRECTION_REVERSED:")) ? ["负成本写成回报时，回报数值增大表示负惩罚减轻，不能写成结果更差。只修改被指出字段中的方向判断，保留原公式、权重未知条件与其他已核实事实；若来源没有说明优化目标，改为只解释代数变化，不擅自断言系统偏好"] : []),
    ...(input.repair.issues.some((issue) => issue.startsWith("TEACHING_ABBREVIATION_PLACEMENT:")) ? ["只修复被指出字段中的中英文定义顺序：缩写必须放在中文全称之前，括号中只保留官方英文全称，例如‘MDP 马尔可夫决策过程（Markov Decision Process）’；不得写成‘马尔可夫决策过程（Markov Decision Process, MDP）’，也不得改动相关事实"] : []),
    ...(input.repair.issues.some((issue) => issue.startsWith("TEACHING_CONCAT_DIMENSION_CONTRADICTION:")) ? ["只修复被指出字段中的拼接维度矛盾：两个 32 维节点向量只能确认拼成 64 维；若公式还含维度未知的边权项，就不能说三者共同拼成 64 维，也不能把包含该项的总输入称为 64 维。分别写清已知的节点对维度、额外项仍未知，以及当前材料无法确认两条公式怎样对应"] : []),
    ...(input.repair.issues.some((issue) => issue === "TEACHING_MISCONCEPTION_REASON_MISSING" || issue === "TEACHING_MISCONCEPTIONS_PACKED") ? ["只改 misconceptions。逐项重写为‘错误理解：……；错因：……；正确判断：……；核对方法：……’四个完整片段；错因必须指出它与本页的对象、条件、运算或关系为何冲突，不能只复述错误。一个数组元素只写一处误解，不得用‘ - ’把多条塞进一项"] : []),
    ...(input.repair.issues.includes("TEACHING_PRIOR_DEFINITION_REPEATED") ? ["先验知识已经定义的术语在完整讲解里只解释如何作用于本页对象，不再使用同一个‘名称：定义’段落重复定义"] : []),
    ...(input.repair.issues.some((issue) => issue.includes("UNPAIRED_ENGLISH")) ? ["逐字段检查承上启下、目标、定义、完整讲解、总结、易错点和四道题的题干与答案解释。普通英文名称或缩写在首次定义后改用已核实的中文名称；首次按策略写成中文全称（官方英文全称），缩写放在中文名称之前。原图中的坐标轴、图例和条目标签若保留英文，逐项用引号包住完整原文，连续列举也不能只给首项加引号；不得把原图标签当作无须解释的普通英语放在正文中。原图中的整段代码原样放进 Markdown 行内代码或代码块，再用中文说明用途；无法核实全称的原图标签用中文引出，并用引号保留原样，说明当前页能确认什么，不得猜测英文全称；原文论文标题用书名号保留。尤其不能让题目解释重新裸用正文已经解释过的缩写"] : []),
    ...(input.repair.issues.includes("TEACHING_PRIOR_DEFINITION_INCOMPLETE") ? ["逐条重写 priorKnowledge：每项只占一个列表项，格式为‘中文全称（已核实的官方英文全称）：是什么；具体做什么；怎样工作；何时使用；如何区分’。按内容选择三至五个完整分句，用中文分号隔开；每句至少十二字，不要把五种关系挤成逗号串，也不要编造英文名称"] : []),
    ...(input.repair.issues.includes("TEACHING_PRIOR_MULTIPLE_DEFINITIONS") ? ["priorKnowledge 每一项只定义一个术语，只用一个中文冒号；需要解释另一个概念时另起一项，或在当前句子中直接说明其作用，不追加第二个‘名称：定义’"] : []),
    ...(input.repair.issues.includes("TEACHING_PRIOR_TRANSLATION_CONFLICT") ? ["逐一核对先验知识中的中英术语配对：同一个中文名称不能在同一项中对应两个不同英文名称。回到原图和已核实术语确定准确译名；若无法核实英文，不写英文，不得只删除冲突提示却保留错误定义"] : []),
    ...(input.repair.issues.some((issue) => issue.startsWith("TEACHING_MATH_INVALID:")) ? ["只修复错误字段中的数学定界符与公式语法：行内公式的开头和结尾各用一个 $，不得在两个 $ 之间换行；显示公式单独用成对 $$；返回前逐式核对 KaTeX 可解析，并保留原有数字、变量和推导关系"] : []),
    ...(input.repair.issues.some((issue) => issue.startsWith("TEACHING_MATH_AS_CODE:")) ? ["只修复被指出字段中的格式：程序语句、命令和真实代码标识符继续使用反引号；状态、动作、回报、参数、向量和公式改用合法 KaTeX 定界符。依据原图恢复下标，不改变对象、数字或关系"] : []),
    ...(input.repair.issues.includes("TEACHING_OBJECTIVE_EXPLANATION_CONTRADICTION") ? ["学习目标与完整讲解必须一致。若来源给出完整函数和更新式，就用通用数学规则完成可复算推导并兑现目标；若确实缺少必要条件，就同步收窄目标。不得一边承诺算出结果，一边说结果无法确定；不得把输入项不同且关系未说明的公式称为等价，不得承诺解释未知拼接项的总维度，也不得在材料只展示布线结果时承诺说出布线方法；正文若证明多个参数同时更新，目标不得再声称只改变被选中动作的参数"] : []),
    ...(input.repair.issues.includes("TEACHING_OBJECT_PRESENCE_CONTRADICTION") ? ["逐段核对同一对象是否出现。来源或正文已经给出的末端回报、公式、节点或步骤不能在另一段被写成‘页面没有给出’；保留真正缺失的系数、单位、定义或因果信息，删除错误的缺失断言"] : []),
    ...(input.repair.issues.includes("TEACHING_LAYOUT_COMMENTARY") ? ["删除完整讲解中关于页码、页脚、版式和装饰位置的说明；只保留真正帮助理解目录层级、对象关系或技术内容的句子，不为了补足长度另写注释"] : []),
    ...(input.repair.issues.includes("TEACHING_IRRELEVANT_ABSENCE_CHECKLIST") ? ["删除与本页要解释的对象无关的‘没有横轴、纵轴、图例或表格’式清单句；若缺少某个图表要素确实限制结论，则只保留该要素及其具体影响，不删掉真实的适用边界"] : []),
    ...(input.repair.issues.some((issue) => issue.startsWith("TEACHING_COVERAGE_")) ? ["只修复 coverageEvidence 时，保留完整讲解和其他字段不变。每个 text_region 的 explanation 都须从现有 fullExplanationMarkdown 中连续摘录至少十二个字符，而且这段话必须真正回答原图对应对象；原图只有简短英文提问或栏目标题时，摘录正文中的回答，不复制短标题冒充覆盖证据"] : []),
    ...(input.repair.issues.includes("TEACHING_BRIDGE_NEEDS_BLOCKS") ? ["chapterBridgeMarkdown 中前页已知事实与本页要解决的问题必须用空行分成两个自然段；两个独立问题必须分行，不要用分号挤在一个长句里"] : []),
    ...(input.repair.issues.includes("TEACHING_ADJACENT_HEADINGS") ? ["fullExplanationMarkdown 中相邻两个标题之间必须补入实际讲解；若只是同一步的两个名称，合并为一个准确标题，把另一个改为正文，不增加空泛过渡句"] : []),
    ...(input.blueprint?.resourcePackage.pageKind === "agenda" ? ["本页是目录，只解释原图已经展示的层级和阅读顺序，不为后续主题补写定义、机制或应用；删除不影响读懂目录的扩写"] : []),
    `fullExplanationMarkdown 最多 ${input.repair.maximumExplanationCharacters} 个字符，必须在完整表达来源事实的前提下压缩到此范围内`,
    "返回完整 TeachingPackage JSON，不得只返回补丁",
    "保留原始课件中的主体、条件、否定、数字、变量、范围和因果关系",
    "保留所有有效 atomId 覆盖声明，并保持恰好 2 道理解题和 2 道选择题",
    "不要新增来源没有提供的事实，不要删掉为理解公式、图形、表格或流程所必需的内容",
    JSON.stringify(input.repair.previousTeachingPackage)
  ].join("\n") : "";
  const finalText = `${text}${blueprintText}${repairText}`;
  if (!input.sourceImageDataUrl) return finalText;
  return [{ role: "user", content: [{ type: "input_text", text: finalText }, { type: "input_image", image_url: input.sourceImageDataUrl, detail: "high" }] }];
}

export function currentGenerationHarness(): GenerationHarnessSnapshot {
  const files = ["teaching-system-prompt.md", "teaching-user-prompt.md", "teaching-blueprint.md", "teaching-package.schema.json", "semantic-audit-prompt.md", "semantic-audit.schema.json", "policy-format-rules.md", "policy-explanation-framework.md", "policy-formula-explanation.md"].map((name) => ({ path: name, sha256: createHash("sha256").update(readHarnessFile(name)).digest("hex") }));
  for (const name of ["app.ts", "generation-harness.ts", "teaching-blueprint.ts", "model-router.ts"]) {
    files.push({ path: `apps/api/src/${name}`, sha256: createHash("sha256").update(readFileSync(resolve(apiSourceDir, name))).digest("hex") });
  }
  files.push({ path: "packages/quality/src/index.ts", sha256: createHash("sha256").update(readFileSync(resolve(apiSourceDir, "../../../packages/quality/src/index.ts"))).digest("hex") });
  const aggregateSha256 = createHash("sha256").update(JSON.stringify({ version: harnessManifest.version, files })).digest("hex");
  return { id: harnessManifest.id, version: harnessManifest.version, taskContract: harnessManifest.taskContract, files, aggregateSha256 };
}
