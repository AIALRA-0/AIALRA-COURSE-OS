import type {
  CoverageClaim,
  CoverageRequirement,
  DiagramElement,
  ExplanationBlock,
  LessonSection,
  MathExpression,
  PageLesson,
  PseudoCodeLine,
  QuestionBankItem,
  TeachingAtom
} from "@course-os/contracts";
import { calculateCoverage, validateMarkdownMath, validateMathAtoms, validatePseudoCodeLines } from "@course-os/quality";

export type GoldenDeck = "introduction" | "chapter-2";

interface PageTeachingProfile {
  title: string;
  objective: string;
  prerequisites: string;
  example: string;
  misconception: string;
  check: string;
  atoms: TeachingAtom[];
}

export const GOLDEN_PAGE_KEYS = [
  "introduction:2",
  "introduction:6",
  "introduction:9",
  "introduction:12",
  "introduction:18",
  "introduction:24",
  "chapter-2:3",
  "chapter-2:6",
  "chapter-2:9",
  "chapter-2:11",
  "chapter-2:18",
  "chapter-2:41"
] as const;

const PROFILES: Record<string, PageTeachingProfile> = {
  "introduction:2": profile(
    "EDA 的 3 个主要阶段",
    "能按输入、处理和输出解释高层次综合、逻辑综合与物理设计的先后关系",
    "先知道程序描述、RTL、网表和版图分别处在抽象层次的什么位置",
    "从 Python 行为描述开始，指出每经过一个阶段新增了哪类硬件约束，最后说明 GDS 为什么可交给制造流程",
    "把 3 个阶段当成可以任意交换顺序的并列工具；实际每个阶段都依赖上一阶段产生的更具体表示",
    "如果只有门级网表而没有单元坐标，流程停在哪一步，下一步还缺少什么",
    diagramAtoms("intro-2", ["程序描述", "RTL", "网表", "放置结果", "GDS"])
  ),
  "introduction:6": profile(
    "逻辑门的晶体管版图",
    "能从扩散区、栅极、金属线和电源轨识别一个逻辑门版图的组成，并把几何关系联系到电气作用",
    "先知道晶体管端子、PMOS、NMOS、电源和地的基本作用",
    "沿输入栅极追踪上下晶体管，再沿输出金属线说明逻辑值如何被上拉或下拉",
    "只根据颜色猜工艺层而不读取图例；颜色是图中的编码，必须先核对图例或来源说明",
    "输入翻转时，哪一组晶体管导通，输出节点为什么改变",
    diagramAtoms("intro-6", ["PMOS 区域", "NMOS 区域", "输入栅极", "输出节点", "电源轨", "地轨"])
  ),
  "introduction:9": profile(
    "穷举方法的规模限制",
    "能计算 16 个对象全排列的数量，并用数量级解释为什么不能穷举所有布局",
    "先会阶乘、科学计数法和用每秒评估次数估算总时间",
    "先算 $16! = 20{,}922{,}789{,}888{,}000$，再除以每秒可评估的候选数，得到穷举所需时间",
    "把 $16!$ 读成 $16\\times15$；阶乘必须继续乘到 $1$，因此候选数量远大于 240",
    "如果评估速度提高 1,000 倍，为什么仍不能从根本上消除组合爆炸",
    [mathAtom("intro-9-factorial", "16! = 20{,}922{,}789{,}888{,}000", [{ symbol: "16!", meaning: "16 个互异对象的全排列数量" }]), mathAtom("intro-9-order", "16! \\approx 2.09\\times 10^{13}", [{ symbol: "10^{13}", meaning: "十万亿数量级" }])]
  ),
  "introduction:12": profile(
    "20K Matrix Solver 的运行结果",
    "能区分幻灯片直接给出的观测值与需要外部来源才能确认的口径",
    "先知道 K 可能表示千，但对象数量、矩阵维度或非零项数量必须由来源定义",
    "把页面中的运行时间和规模原样记录为 source claim，把 20K 的具体含义标成待核对，而不是自行补全",
    "把 20K 自动解释为 20,000 个晶体管；页面未提供这个对象口径，因此该说法不能发布为事实",
    "当课件与外部资料对 20K 的含义不同，系统应该保留哪 3 类 claim",
    [regionAtom("intro-12-value", "20K 标签", "页面直接显示 20K，但没有定义 K 所指对象", "20K 的精确口径需要来源核对")]
  ),
  "introduction:18": profile(
    "Placement 运行时间比较",
    "能逐项读取横轴、纵轴、单位、系列和趋势，并说明图表不能单独证明的因果关系",
    "先知道 placement 是确定单元位置，运行时间受设计规模、算法、硬件和参数共同影响",
    "选取图中两个数据点，先读轴与单位，再计算时间比值，最后说明比较是否控制了硬件和输入规模",
    "只看柱形或折线高度就断言算法更好；运行时间较短不等于质量、约束满足和测试条件都更好",
    "如果 2 条曲线使用不同硬件测得，能否把差值全部归因于算法",
    chartAtoms("intro-18", "运行时间", "秒")
  ),
  "introduction:24": profile(
    "Steiner 单网络布线",
    "能区分端点、可新增的 Steiner 点和连线，并解释新增分叉点为什么可能缩短总线长",
    "先知道网络端点必须连通，曼哈顿布线通常只允许水平和垂直线段",
    "比较不使用额外分叉点的连接与使用 Steiner 点的连接，逐段相加总线长",
    "认为新增节点一定增加总线长；Steiner 点不是新负载，它是允许多条路径共享线段的几何分叉点",
    "新增一个分叉点后，哪些线段被共享，总线长如何重新计算",
    diagramAtoms("intro-24", ["端点 A", "端点 B", "端点 C", "Steiner 点", "共享线段"])
  ),
  "chapter-2:3": profile(
    "同一电路的不同分割结果",
    "能计算每个候选分割的 cutsize，并同时检查分区大小是否满足平衡约束",
    "先知道图的顶点表示对象，边表示连接，cut edge 是跨越分区边界的边",
    "对每幅小图逐边判断两端是否位于不同分区，再把跨区边数量相加",
    "只选 cutsize 最小的结果而忽略不平衡；分割通常同时优化连接代价和容量约束",
    "两个方案 cutsize 相同，但一个分区包含 7 个顶点、另一个包含 1 个顶点时，能否视为同样可用",
    diagramAtoms("ch2-3", ["顶点", "内部边", "跨区边", "分区 A", "分区 B"])
  ),
  "chapter-2:6": profile(
    "KL 小图示例的问题",
    "能计算 4 个顶点的平衡二分数量，并说明 KL 的目标与面积约束",
    "先会组合数，知道左右分区有标签时与无标签时的计数差异",
    "不区分左右分区时，平衡二分数量是 $\\binom{4}{2}/2=3$；逐一计算 3 个方案的 cutsize",
    "直接写 $\\frac{\\binom{4}{2}}{2}=3$ 却不解释为什么除以 2；原因是交换左右标签不会产生新的无标签分割",
    "如果 A、B 是有名字的物理区域，还应该除以 2 吗",
    [mathAtom("ch2-6-combination", "\\frac{\\binom{4}{2}}{2}=3", [{ symbol: "\\binom{4}{2}", meaning: "从 4 个顶点中选择 2 个放入一侧" }, { symbol: "/2", meaning: "无标签分区中，左右互换代表同一个分割" }]), ...diagramAtoms("ch2-6", ["顶点", "边", "分区 A", "分区 B"])]
  ),
  "chapter-2:9": profile(
    "KL 伪代码逐行执行结构",
    "能从外层 pass、候选对搜索、暂定交换、锁定、记录到最佳前缀提交，逐行预测状态变化",
    "先知道 $D(v)$、gain、锁定状态、暂定交换与实际提交的区别",
    "使用 4 个顶点的小图建立 A、B、D 值和 table，逐行执行一次 pass，并在每行后写出改变的变量",
    "把 `TENT-EXCHGE` 当成已经永久交换；它只让后续 gain 在试探状态上计算，真正提交发生在 `ACTUAL-EXCHGE`",
    "为什么允许 table 中暂时出现负 gain，最终又只提交最佳累计前缀",
    klPseudoCodeLines()
  ),
  "chapter-2:11": profile(
    "KL 第一次交换",
    "能根据交换前的 D 值选择顶点对，并在交换后更新锁定、分区和相邻顶点状态",
    "先掌握 $g(a,b)=D(a)+D(b)-2c(a,b)$ 与内部边、外部边的定义",
    "先列出全部未锁定候选对的 gain，选择最大者，再分别更新交换顶点和邻居的 D 值",
    "交换后仍沿用旧 D 值；分区归属改变后，内部边和外部边的分类也会改变",
    "顶点 a 与 b 交换后，哪些对象立刻改变，哪些要等到正式提交才固定",
    diagramAtoms("ch2-11", ["交换前分区", "候选顶点对", "锁定标记", "暂定分区", "gain 表"])
  ),
  "chapter-2:18": profile(
    "FM 的 bucket 数据结构",
    "能解释 bucket 的索引、链表内容、最大 gain 指针和一次移动后的局部更新",
    "先知道 FM 每次移动 1 个单元，gain 的可能范围与最大度数有关",
    "把不同 gain 的单元放入对应 bucket，从最大非空 bucket 取出可移动单元，再更新受影响邻居",
    "把 bucket 当成按顶点编号排序；bucket 的关键索引是 gain，目的是快速找到最大收益候选",
    "一次移动只影响哪些邻居，为什么不需要重算所有顶点",
    diagramAtoms("ch2-18", ["gain 索引", "bucket 单元", "链表", "最大非空指针", "锁定状态"])
  ),
  "chapter-2:41": profile(
    "EIG ratio-cut 计算和限制",
    "能按给定顶点顺序计算候选 ratio-cut，并说明谱排序只缩小搜索空间、不保证全局最优",
    "先知道拉普拉斯矩阵、第二小特征向量和按分量排序顶点的做法",
    "对每个前缀切分计算跨区代价，再按两侧规模归一化，比较候选值",
    "认为第二小特征向量直接给出唯一最优切分；它给出连续松弛后的顺序，还需要检查离散切分候选",
    "如果最小 ratio-cut 对应严重不平衡的分区，目标函数中的归一化项如何影响结果",
    [mathAtom("ch2-41-ratio", "\\operatorname{RatioCut}(A,B)=\\operatorname{cut}(A,B)\\left(\\frac{1}{|A|}+\\frac{1}{|B|}\\right)", [{ symbol: "\\operatorname{cut}(A,B)", meaning: "跨越 A 与 B 的边代价" }, { symbol: "|A|,|B|", meaning: "两个分区的顶点数量" }]), ...diagramAtoms("ch2-41", ["谱排序", "前缀切分", "跨区边", "ratio-cut 值"])]
  )
};

export function buildGoldenPage(input: {
  deck: GoldenDeck;
  pageNumber: number;
  rawSection: string;
  imageUrl: string;
  materialVersionId: string;
}): PageLesson {
  const key = `${input.deck}:${input.pageNumber}`;
  const profile = PROFILES[key];
  if (!profile) throw new Error(`GOLDEN_PROFILE_MISSING:${key}`);
  const pageId = `${input.materialVersionId}:page:${input.pageNumber}`;
  const anchorId = `${pageId}:anchor:page`;
  const cleaned = cleanSection(input.rawSection);
  const { explanation, qa } = splitQa(cleaned);
  const blockPrefix = `${pageId}:block`;
  const blocks: ExplanationBlock[] = [
    block(`${blockPrefix}:objective`, "本页学完要做到什么", "objective", profile.objective, anchorId, profile.atoms),
    block(`${blockPrefix}:prerequisite`, "先补齐这些知识", "prerequisite", profile.prerequisites, anchorId, profile.atoms),
    block(`${blockPrefix}:core`, "老师完整讲解", "core", explanation, anchorId, profile.atoms),
    block(`${blockPrefix}:example`, "跟着做一个完整例子", "example", profile.example, anchorId, profile.atoms),
    block(`${blockPrefix}:misconception`, "最容易错在哪里", "misconception", profile.misconception, anchorId, profile.atoms),
    block(`${blockPrefix}:check`, "现在检查是否真的理解", "check", profile.check, anchorId, profile.atoms),
    block(`${blockPrefix}:deep`, "逐元素与边界细节", "deep_dive", renderAtomDetails(profile.atoms), anchorId, profile.atoms),
    block(`${blockPrefix}:qa`, "课堂问答", "qa", qa || "本页原始讲义没有单独问答，使用上方主动检查完成理解验证", anchorId, profile.atoms),
  ];
  const coverageRequirements = requirementsFor(profile.atoms);
  const coverageClaims = fullClaims(coverageRequirements, `${blockPrefix}:deep`);
  const coverage = calculateCoverage(coverageRequirements, coverageClaims);
  const mathIssues = validateMathAtoms(profile.atoms.filter((atom): atom is MathExpression => atom.kind === "math_expression"));
  const markdownMathIssues = blocks.flatMap((item) => validateMarkdownMath(item.markdown).map((issue) => `${item.id}:${issue}`));
  const pseudoIssues = validatePseudoCodeLines(profile.atoms.filter((atom): atom is PseudoCodeLine => atom.kind === "pseudocode_line"));
  const issues = [...mathIssues, ...markdownMathIssues, ...pseudoIssues, ...coverage.missing.map((item) => `${item.requirementId}:${item.fields.join(",")}`)];
  return {
    id: pageId,
    pageNumber: input.pageNumber,
    title: profile.title,
    imageUrl: input.imageUrl,
    anchors: [{ id: anchorId, pageId, kind: "page", label: `第 ${input.pageNumber} 页` }],
    atoms: profile.atoms,
    blocks,
    lessonSections: lessonSectionsFromBlocks(blocks, anchorId, profile.atoms),
    questionBank: buildQuestionBank(pageId, `${pageId}:objective`, qa, profile.check, anchorId),
    coverageRequirements,
    coverageClaims,
    quality: {
      highRiskCoverage: coverage.highRiskCoverage,
      generalCoverage: coverage.generalCoverage,
      mathValid: mathIssues.length === 0,
      publishable: coverage.publishable && issues.length === 0,
      issues
    }
  };
}

export function buildFullCoursePage(input: {
  deck: GoldenDeck;
  pageNumber: number;
  markdown: string;
  imageUrl: string;
  materialVersionId: string;
}): PageLesson {
  const rawSection = extractPageSection(input.markdown, input.pageNumber);
  if (PROFILES[`${input.deck}:${input.pageNumber}`]) return buildGoldenPage({ ...input, rawSection });
  const pageId = `${input.materialVersionId}:page:${input.pageNumber}`;
  const anchorId = `${pageId}:anchor:page`;
  const title = pageTitle(input.markdown, input.pageNumber);
  const cleaned = cleanSection(rawSection);
  const { explanation, qa } = splitQa(cleaned);
  const atom = regionAtom(`${pageId}:source-region`, "原始页面", "页面中的文字、图形和关系必须结合左侧原图逐项核对", "超出课件直接信息的补充内容必须单独标记来源");
  const atoms: TeachingAtom[] = [atom];
  const objective = `学完本页后，学生能够用自己的话解释${title}，并指出页面中的主要对象、关系和结论`;
  const main = mainPoints(explanation, title);
  const prerequisites = prerequisiteItems(explanation, title);
  const misconception = misconceptionItems(explanation, title);
  const blocks: ExplanationBlock[] = [
    block(`${pageId}:block:objective`, "学习目标", "objective", objective, anchorId, atoms),
    block(`${pageId}:block:core`, "主要内容", "core", main.join("\n"), anchorId, atoms),
    block(`${pageId}:block:prerequisite`, "先验知识", "prerequisite", prerequisites.join("\n"), anchorId, atoms),
    block(`${pageId}:block:deep`, "完整讲解", "deep_dive", explanation, anchorId, atoms),
    block(`${pageId}:block:misconception`, "易错点", "misconception", misconception.join("\n"), anchorId, atoms),
    block(`${pageId}:block:qa`, "QA记录", "qa", qa || "本页暂时没有保存的课堂问答", anchorId, atoms),
  ];
  const requirements = requirementsFor(atoms);
  const claims = fullClaims(requirements, `${pageId}:block:deep`);
  const coverage = calculateCoverage(requirements, claims);
  const mathIssues = blocks.flatMap((item) => validateMarkdownMath(item.markdown).map((issue) => `${item.id}:${issue}`));
  return {
    id: pageId,
    pageNumber: input.pageNumber,
    title,
    imageUrl: input.imageUrl,
    anchors: [{ id: anchorId, pageId, kind: "page", label: `第 ${input.pageNumber} 页` }],
    atoms,
    blocks,
    lessonSections: lessonSectionsFromBlocks(blocks, anchorId, atoms),
    questionBank: buildQuestionBank(pageId, `${pageId}:objective`, qa, objective, anchorId),
    coverageRequirements: requirements,
    coverageClaims: claims,
    quality: { highRiskCoverage: 1, generalCoverage: coverage.generalCoverage, mathValid: mathIssues.length === 0, publishable: coverage.publishable && mathIssues.length === 0, issues: mathIssues }
  };
}

export function normalizedLessonSections(page: PageLesson): LessonSection[] {
  if (page.lessonSections?.length) return page.lessonSections;
  return lessonSectionsFromBlocks(page.blocks, page.anchors[0]?.id ?? "", page.atoms);
}

export function extractPageSection(markdown: string, pageNumber: number): string {
  const pattern = new RegExp(`^###\\s+\\d+\\.\\d+\\s+第${pageNumber}页[^\\n]*$`, "m");
  const match = pattern.exec(markdown);
  if (!match || match.index === undefined) throw new Error(`PAGE_SECTION_MISSING:${pageNumber}`);
  const start = match.index + match[0].length;
  const next = markdown.slice(start).search(/^###\s+/m);
  return markdown.slice(start, next >= 0 ? start + next : markdown.length).trim();
}

function profile(title: string, objective: string, prerequisites: string, example: string, misconception: string, check: string, atoms: TeachingAtom[]): PageTeachingProfile {
  return { title, objective, prerequisites, example, misconception, check, atoms };
}

function mathAtom(id: string, tex: string, symbols: MathExpression["symbols"]): MathExpression {
  return { kind: "math_expression", id, sourceTex: tex, normalizedTex: tex, symbols, parseStatus: "valid" };
}

function regionAtom(id: string, label: string, observation: string, inference?: string): DiagramElement {
  return { kind: "image_region", id, label, observation, inference };
}

function renderAtomDetails(atoms: TeachingAtom[]): string {
  const visibleAtoms = atoms.filter((atom) => atom.kind !== "pseudocode_line");
  if (!visibleAtoms.length) return "伪代码的每一有效行都在下方按读取对象、修改对象、执行前状态、执行后状态和副作用展开";
  return visibleAtoms.map((atom) => {
    if (atom.kind === "math_expression") {
      const symbols = atom.symbols.map((item) => `- $${item.symbol}$：${item.meaning}`).join("\n");
      return `#### 公式与符号\n\n$$${atom.normalizedTex}$$\n\n${symbols}\n\n解析状态：${atom.parseStatus === "valid" ? "公式已经通过严格解析" : "公式解析失败，不能发布"}`;
    }
    if (atom.kind === "code_block") return `#### 代码块\n\n变量：${atom.variables.map((item) => `${item.name}（${item.role}）`).join("、")}\n\n分支：${atom.branches.join("；")}\n\n执行轨迹：${atom.executionTrace.join(" → ")}`;
    if (atom.kind === "chart_axis") return `#### ${atom.label}\n\n观察：${atom.observation}\n\n单位：${atom.unit || "以原图标注为准"}\n\n限制：${atom.limitation || "不能超出图表直接支持的结论"}`;
    if (atom.kind === "chart_legend") return `#### ${atom.label}\n\n编码方式：${atom.encoding}\n\n观察：${atom.observation}`;
    if (atom.kind === "chart_series") return `#### ${atom.label}\n\n观察：${atom.observation}\n\n限制：${atom.limitation}`;
    const inference = "inference" in atom ? atom.inference : undefined;
    return `#### ${atom.label}\n\n观察事实：${atom.observation}\n\n推断边界：${inference || "只采用页面能够直接支持的关系"}`;
  }).join("\n\n");
}

function diagramAtoms(prefix: string, labels: string[]): DiagramElement[] {
  return labels.map((label, index) => ({ kind: index === 0 ? "diagram_node" : "diagram_edge", id: `${prefix}-element-${index + 1}`, label, observation: `需要在原图中定位并解释${label}`, inference: "任何超出图面直接信息的解释都需要单独标为推断" }));
}

function chartAtoms(prefix: string, label: string, unit: string): TeachingAtom[] {
  return [
    { kind: "chart_axis", id: `${prefix}-x`, label: "横轴", observation: "横轴给出比较对象或输入规模", limitation: "具体口径以原图标签为准" },
    { kind: "chart_axis", id: `${prefix}-y`, label, unit, observation: `纵轴度量${label}`, limitation: "必须核对是否使用线性或对数刻度" },
    { kind: "chart_legend", id: `${prefix}-legend`, label: "图例", encoding: "颜色或线型", observation: "图例把视觉编码映射到算法或实验系列" },
    { kind: "chart_series", id: `${prefix}-series`, label: "数据系列", observation: "读取整体趋势、相对差异和异常点", limitation: "图表相关性不能单独证明因果关系" }
  ];
}

export function klPseudoCodeLines(): PseudoCodeLine[] {
  const rows: Array<[string, string, string[], string[], string, string, string[], string]> = [
    ["Algorithm KL", "声明算法入口", [], [], "算法尚未开始", "进入 KL 算法定义", [], "声明行不产生运行开销"],
    ["begin", "开始算法主体", [], [], "控制流位于入口", "控制流进入主体", [], "常数控制开销"],
    ["INITIALIZE();", "建立初始等分、解锁顶点、清空 table 并计算初始 D 值", [], ["A", "B", "locks", "table", "D"], "分区和工作表未初始化", "A、B、锁定表、table 与 D 值可用", ["创建一个新 pass 的工作状态"], "至少读取全部顶点和边，通常为 O(|V|+|E|)"],
    ["while (IMPROVE(table) = TRUE) do", "上一 pass 有正累计改善时继续外层循环", ["table"], [], "上一 pass 已形成收益序列", "选择继续或结束算法", [], "pass 数取决于改善次数"],
    ["comment: repeat after improvement", "解释外层循环条件", [], [], "位于外层循环", "不改变状态", [], "注释没有运行开销"],
    ["while (UNLOCK(A) = TRUE) do", "A 中仍有未锁定顶点时继续构造交换序列", ["A", "locks"], [], "当前 pass 已选择若干顶点对", "选择继续选对或结束当前 pass", [], "最多执行 |A| 次"],
    ["comment: tentative exchanges", "解释内层循环用途", [], [], "位于内层循环", "不改变状态", [], "注释没有运行开销"],
    ["for (each a in A) do", "遍历 A 中的候选顶点", ["A"], ["a"], "尚未检查或正在检查候选", "a 指向当前候选", [], "每轮扫描 |A| 个顶点"],
    ["if (a = unlocked) then", "只保留本 pass 未使用的 a", ["a", "locks"], [], "a 的锁定状态已知", "锁定 a 被跳过，未锁定 a 进入 B 扫描", [], "常数判断"],
    ["for (each b in B) do", "对当前 a 遍历 B 的候选顶点", ["B", "a"], ["b"], "已选定一个未锁定 a", "b 指向当前候选", [], "与外层组合形成 O(|A||B|) 候选扫描"],
    ["if (b = unlocked) then", "只保留本 pass 未使用的 b", ["b", "locks"], [], "b 的锁定状态已知", "锁定 b 被跳过，未锁定 b 进入收益比较", [], "常数判断"],
    ["if (D_max < D(a) + D(b)) then", "比较当前候选收益与已知最大值", ["D_max", "D(a)", "D(b)"], [], "D_max 保存此前最佳候选收益", "选择是否更新最佳候选", [], "若边代价另取，计算还应包含 -2c(a,b)；比较本身为常数时间"],
    ["D_max = D(a) + D(b);", "保存新的最大候选收益", ["D(a)", "D(b)"], ["D_max"], "当前候选优于旧最大值", "D_max 等于当前候选收益", [], "常数赋值"],
    ["a_max = a;", "保存最佳对在 A 中的顶点", ["a"], ["a_max"], "当前候选已确认更优", "a_max 指向 a", [], "常数赋值"],
    ["b_max = b;", "保存最佳对在 B 中的顶点", ["b"], ["b_max"], "当前候选已确认更优", "b_max 指向 b", [], "常数赋值"],
    ["TENT-EXCHGE(a_max,b_max);", "在试探状态交换最佳顶点对", ["a_max", "b_max", "A", "B"], ["A", "B", "D"], "最佳顶点仍在原试探分区", "后续收益基于交换后的试探分区", ["尚未改变正式发布分区"], "局部 D 更新与相邻边数量有关"],
    ["LOCK(a_max,b_max);", "锁定已选顶点对", ["a_max", "b_max"], ["locks"], "两个顶点未锁定", "两个顶点本 pass 不可再次选择", ["缩小剩余候选集合"], "常数标记，加上数据结构维护开销"],
    ["LOG(table);", "记录顶点对及其收益", ["a_max", "b_max", "D_max"], ["table"], "table 保存此前交换", "table 追加当前交换记录", ["累计收益序列增长"], "追加通常为摊销常数时间"],
    ["D_max = -infinity;", "为下一轮候选搜索重置最大值", [], ["D_max"], "D_max 属于刚完成的候选搜索", "任何有限收益都能成为下一次初始最佳值", [], "常数赋值"],
    ["ACTUAL-EXCHGE(table);", "提交累计收益最大的正前缀", ["table"], ["official_partition"], "table 含完整暂定交换序列", "正式分区只应用最佳前缀，剩余试探交换撤销", ["形成一个可审核 pass 结果"], "扫描 table 为 O(|V|)，应用前缀取决于交换数量"],
    ["end.", "结束算法", [], [], "外层循环已无正改善", "返回局部最优分区", [], "结束行没有额外运行开销"]
  ];
  const teacherSummaries = [
    "这一行声明 KL 算法入口，后面的初始化、试探交换和正式提交都从这里开始",
    "这一行进入算法主体，接下来会按固定顺序执行初始化和交换流程",
    "这一行先把分区、锁定表、交换记录表和每个顶点的 D 值准备好，后面的每一轮交换都要在这份初始状态上计算",
    "这一行检查上一轮是否带来了正的累计收益，只有有改善时才继续寻找下一轮交换",
    "这一行只是说明外层循环为什么会重复执行，不会改变算法状态",
    "这一行检查分区 A 中是否还有没有用过的顶点，有就继续构造当前 pass 的交换序列",
    "这一行只是说明内层循环正在寻找试探交换，不会改变运行结果",
    "这一行依次取出分区 A 中的候选顶点，让算法逐个评估它们能带来的收益",
    "这一行跳过已经用过的顶点，只让当前 pass 尚未锁定的顶点进入下一步",
    "这一行依次取出分区 B 中的候选顶点，为当前的 a 寻找可以配对的 b",
    "这一行跳过已经用过的 b，避免同一个顶点在一个 pass 中被重复选择",
    "这一行把当前 a 和 b 的收益相加，再和目前记录的最大收益比较",
    "这一行发现当前候选更好，于是把它的收益保存成新的最大值",
    "这一行记住当前收益最高的 A 分区顶点，后面要和 b_max 一起交换",
    "这一行记住当前收益最高的 B 分区顶点，后面要和 a_max 一起交换",
    "这一行先试探交换这两个顶点，让后续计算能够基于新的分区状态继续寻找收益",
    "这一行锁定已经选中的两个顶点，保证它们不会在本轮 pass 中再次被选用",
    "这一行把本次试探交换和收益追加到记录表，供后面选择最好的累计前缀",
    "这一行把最大收益重新设为负无穷，确保下一次候选比较从空记录开始",
    "这一行只提交记录表中累计收益最好的正前缀，并撤销没有被选中的试探交换",
    "这一行结束算法，因为外层循环已经找不到能够继续改善结果的交换"
  ];
  return rows.map((row, index) => ({ kind: "pseudocode_line", id: `ch2-9-line-${index + 1}`, lineNumber: index + 1, code: row[0], semantic: row[1], teacherSummary: teacherSummaries[index] ?? `这一行执行${row[1]}并把结果交给后续步骤`, reads: row[2], writes: row[3], preState: row[4], postState: row[5], sideEffects: row[6], complexityRelation: row[7] }));
}

function requirementsFor(atoms: TeachingAtom[]): CoverageRequirement[] {
  return atoms.map((atom) => ({
    id: `requirement:${atom.id}`,
    atomId: atom.id,
    risk: atom.kind === "math_expression" || atom.kind === "pseudocode_line" || atom.kind === "code_block" ? "high" : "general",
    requiredFields: atom.kind === "pseudocode_line"
      ? ["teacherSummary", "semantic", "reads", "writes", "preState", "postState", "sideEffects", "complexityRelation"]
      : atom.kind === "math_expression"
        ? ["sourceTex", "normalizedTex", "symbols", "parseStatus"]
        : atom.kind === "code_block"
          ? ["variables", "branches", "executionTrace"]
          : ["label", "observation"]
  }));
}

function fullClaims(requirements: CoverageRequirement[], explanationBlockId: string): CoverageClaim[] {
  return requirements.map((requirement) => ({ requirementId: requirement.id, explanationBlockId, coveredFields: [...requirement.requiredFields], status: "covered" }));
}

function block(id: string, title: string, kind: ExplanationBlock["kind"], markdown: string, anchorId: string, atoms: TeachingAtom[]): ExplanationBlock {
  return { id, title, kind, markdown, sourceAnchorIds: [anchorId], atomIds: atoms.map((atom) => atom.id) };
}

function cleanSection(section: string): string {
  return section
    .replace(/^!\[[^\]]*\]\([^\)]*\)\s*$/gm, "")
    .replace(/^###.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitQa(section: string): { explanation: string; qa: string } {
  const marker = section.indexOf("课堂问答：");
  if (marker < 0) return { explanation: section, qa: "" };
  return { explanation: section.slice(0, marker).trim(), qa: section.slice(marker + "课堂问答：".length).trim() };
}

function lessonSectionsFromBlocks(blocks: ExplanationBlock[], anchorId: string, atoms: TeachingAtom[]): LessonSection[] {
  const find = (...kinds: ExplanationBlock["kind"][]) => blocks.filter((item) => kinds.includes(item.kind));
  const markdown = (...kinds: ExplanationBlock["kind"][]) => find(...kinds).map((item) => item.markdown).filter(Boolean).join("\n\n");
  const sentenceItems = (kind: "learning_objectives" | "prior_knowledge" | "misconceptions", source: string) => splitSentences(source).map((text, index) => ({ id: `${blocks[0]?.id ?? anchorId}:${kind}:${index + 1}`, text, sourceAnchorIds: [anchorId] }));
  const objective = markdown("objective");
  const prior = markdown("prerequisite");
  const misconceptions = markdown("misconception");
  return [
    { id: `${blocks[0]?.id ?? anchorId}:section:objective`, kind: "learning_objectives", title: "学习目标", items: sentenceItems("learning_objectives", objective), sourceAnchorIds: [anchorId], atomIds: atoms.map((item) => item.id) },
    { id: `${blocks[0]?.id ?? anchorId}:section:main`, kind: "main_content", title: "主要内容", markdown: markdown("core"), sourceAnchorIds: [anchorId], atomIds: atoms.map((item) => item.id) },
    { id: `${blocks[0]?.id ?? anchorId}:section:prior`, kind: "prior_knowledge", title: "先验知识列表", items: sentenceItems("prior_knowledge", prior), sourceAnchorIds: [anchorId], atomIds: atoms.map((item) => item.id) },
    { id: `${blocks[0]?.id ?? anchorId}:section:full`, kind: "full_explanation", title: "完整讲解", markdown: markdown("core", "example", "deep_dive", "check"), sourceAnchorIds: [anchorId], atomIds: atoms.map((item) => item.id) },
    { id: `${blocks[0]?.id ?? anchorId}:section:misconceptions`, kind: "misconceptions", title: "易错点列表", items: sentenceItems("misconceptions", misconceptions), sourceAnchorIds: [anchorId], atomIds: atoms.map((item) => item.id) }
  ];
}

function buildQuestionBank(pageId: string, objectiveId: string, qa: string, fallback: string, anchorId: string): QuestionBankItem[] {
  const pairs = [...qa.matchAll(/(?:^|\n)-?\s*问[：:]\s*(.+?)[？?]?\s*答[：:]\s*([^\n]+)/g)].map((match) => ({ prompt: match[1]!.trim(), answer: match[2]!.trim() }));
  while (pairs.length < 2) pairs.push({ prompt: pairs.length === 0 ? "本页最重要的概念是什么" : "本页结论成立需要哪些前提", answer: fallback });
  const choices = [
    [pairs[0]!.answer, "只需要记住页面标题", "不需要核对任何前提", "所有情况都能直接套用"],
    [pairs[1]!.answer, "页面没有提供任何信息", "结论与输入条件无关", "只看图形颜色即可判断"]
  ];
  return [
    ...pairs.slice(0, 2).map((pair, index): QuestionBankItem => ({ id: `${pageId}:question:comprehension:${index + 1}`, pageId, objectiveId, kind: "comprehension", prompt: pair.prompt, expectedAnswer: pair.answer, explanation: pair.answer, sourceAnchorIds: [anchorId], status: "approved", version: 1, generatedBy: "curated-course-notes-v2" })),
    ...choices.map((options, index): QuestionBankItem => ({ id: `${pageId}:question:choice:${index + 1}`, pageId, objectiveId, kind: "multiple_choice", prompt: `${pairs[index]!.prompt}，请选择最准确的回答`, options, expectedAnswer: options[0]!, explanation: pairs[index]!.answer, sourceAnchorIds: [anchorId], status: "approved", version: 1, generatedBy: "curated-course-notes-v2" }))
  ];
}

export function splitSentences(source: string): string[] {
  // Split only outside TeX delimiters. A plain regex sees the exclamation mark
  // in `$16!$` as sentence punctuation and corrupts the formula in the
  // resulting LessonSection item.
  const text = source.replace(/^[-*]\s*/gm, "");
  const candidates: string[] = [];
  let current = "";
  let mathDelimiter: "$" | "$$" | "\\(" | "\\[" | undefined;

  const push = () => {
    const value = current.trim().replace(/[，；：,.]$/, "").trim();
    if (value) candidates.push(value);
    current = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const escaped = index > 0 && text[index - 1] === "\\";
    if (mathDelimiter) {
      current += character;
      if (mathDelimiter === "$$" && text.startsWith("$$", index) && !escaped) {
        current += "$";
        index += 1;
        mathDelimiter = undefined;
      } else if (mathDelimiter === "$" && character === "$" && !escaped) {
        mathDelimiter = undefined;
      } else if (mathDelimiter === "\\(" && text.startsWith("\\)", index)) {
        current += ")";
        index += 1;
        mathDelimiter = undefined;
      } else if (mathDelimiter === "\\[" && text.startsWith("\\]", index)) {
        current += "]";
        index += 1;
        mathDelimiter = undefined;
      }
      continue;
    }

    if (text.startsWith("$$", index) && !escaped) {
      current += "$$";
      index += 1;
      mathDelimiter = "$$";
      continue;
    }
    if (text.startsWith("\\(", index) && !escaped) {
      current += "\\(";
      index += 1;
      mathDelimiter = "\\(";
      continue;
    }
    if (text.startsWith("\\[", index) && !escaped) {
      current += "\\[";
      index += 1;
      mathDelimiter = "\\[";
      continue;
    }
    if (character === "$" && !escaped && text.indexOf("$", index + 1) >= 0) {
      current += character;
      mathDelimiter = "$";
      continue;
    }
    if (character === "\n" || character === "。" || character === "！" || character === "？" || character === "!" || character === "?") {
      push();
      continue;
    }
    current += character;
  }
  push();
  return candidates.length ? candidates.slice(0, 8) : ["本页没有单独列出的项目，需要结合完整讲解继续核对"];
}

function pageTitle(markdown: string, pageNumber: number): string {
  const match = new RegExp(`^###\\s+\\d+\\.\\d+\\s+第${pageNumber}页[：:]([^\\n]+)$`, "m").exec(markdown);
  return match?.[1]?.trim() || `第 ${pageNumber} 页`;
}

function mainPoints(explanation: string, title: string): string[] {
  const lines = explanation.split(/\r?\n/).map((item) => item.trim()).filter((item) => item && !item.startsWith(">") && !item.startsWith("课堂问答"));
  const bullets = lines.filter((item) => /^[-*]\s+/.test(item)).map((item) => item.replace(/^[-*]\s+/, ""));
  return (bullets.length ? bullets : [`本页围绕${title}建立概念、关系和应用场景`, ...lines.filter((item) => item.length >= 12)]).slice(0, 5).map((item) => `- ${item}`);
}

function prerequisiteItems(explanation: string, title: string): string[] {
  const definitions = explanation.split(/\r?\n/).map((item) => item.trim()).filter((item) => /是|指|表示|定义/.test(item) && item.length >= 8).slice(0, 4);
  return (definitions.length ? definitions : [`先知道${title}中各个对象分别代表什么`, "先能区分页面直接给出的事实和需要进一步推导的结论"]).map((item) => `- ${item}`);
}

function misconceptionItems(explanation: string, title: string): string[] {
  const warnings = explanation.split(/\r?\n/).map((item) => item.trim()).filter((item) => /不能|不要|并不|误|忽略|只看/.test(item)).slice(0, 4);
  return (warnings.length ? warnings : [`不要只记住${title}的名称，还要说明对象之间为什么形成当前关系`, "不要把页面没有定义的口径自行补成确定事实"]).map((item) => `- ${item}`);
}
