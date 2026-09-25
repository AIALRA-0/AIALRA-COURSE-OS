# Slim 教学质量固定基准

## 目的与边界

本基准登记用户指定的 11 类页面，并从本地保存的课程快照中选择有来源证据的代表页。旧页评估可离线复跑；缺少页面正文或原始来源的类别留作缺口，不以近似页面冒充

候选清单位于 `evals/slim-teaching-quality-fixed-11.json`。该文件使用现有 `eval:teaching:fast` 清单字段，固定 7 个可离线评估的旧页。类别总数是 11；纯文字、独立代码和历史失败页当前没有足以复跑内容评估的完整本地样本，因此不会被清单的 7 页结果覆盖

## 11 类覆盖表

| 用户指定类别 | 固定代表页或现有证据 | 当前 Slim 证据与限制 |
|---|---|---|
| 纯文字 | 暂无 | 不能确认；Introduction 20 是文字清单型幻灯片，不等于纯文字来源页 |
| 概念 | Introduction 20，课程教学范围 | Slim 有对应候选页；页面是图像来源的幻灯片 |
| 公式推导 | Chapter 2 第 41 页，ratio-cut 计算 | 没有对应 Slim 推导页；Slim Chapter 2 第 46 页是定理与代入计算，不能代替多步推导样本 |
| 表格矩阵 | Chapter 2 第 37 页，邻接矩阵 | 旧页及 Slim 对照均有记录；归档原子只标为 `image_region`，矩阵类型由页面内容和人工登记确认 |
| 图表 | Introduction 18，Placement 运行时间比较 | 有 `chart_axis`、`chart_legend`、`chart_series`；旧页及 Slim 对照均有记录 |
| 示意图 | Chapter 2 第 6 页，KL 小图示例 | 快照含节点、边和公式；归档结构含 1 个节点和 3 条边。没有对应 Slim 页记录 |
| 代码 | 暂无 | 归档讲解中有 `text` 围栏包住的 FM 算法步骤，也有模拟退火算法步骤；这些是算法伪代码，现有来源不能确认独立的编程语言代码页，也没有对应 Slim 页记录 |
| 伪代码 | Chapter 2 第 9 页，KL 伪代码 | 有 21 条 `pseudocode_line`；旧页及 Slim 对照均有记录。评测器会把伪代码也自动打上 `code` 特征标签，因此该标签不能证明存在独立代码页 |
| 复杂视觉关系 | Chapter 2 第 41 页，EIG ratio-cut | 保存的原始页图呈现带权图及多个候选切分，和公式计算同页；该图像来自本地 CAS，哈希为 `f230f593828d3026652cf674a7f2a3bb5b2a394a1b2f44ebd3ea867921c77150`。没有对应 Slim 页记录 |
| 短过渡页 | Chapter 2 第 1 页，章节入口 | 旧页讲解区共 485 个字符，可代表短章节引入；没有对应 Slim 页记录 |
| 历史失败页 | UbD Debug 材料第 5 页 | Slim 历史报告标为失败恢复页，候选 ID 为 `page:9b0c548e596c2846aff5e79b5e8a30c696a12b99d0a439f545728bb280b716ee:5`。有浏览器截图和人工结论，但缺少本地完整候选正文及旧正式对照，故不进入离线运行 |

## 离线运行

工作目录为仓库根目录，命令读取已保存的旧课程快照，并将 JSON 结果与 Markdown 摘要写入被忽略的 `var/eval/`

```powershell
pnpm eval:teaching:fast -- --input var/readweave-course-store.json --manifest evals/slim-teaching-quality-fixed-11.json --json-out var/eval/slim-teaching-quality-fixed-11.json --markdown-out var/eval/slim-teaching-quality-fixed-11.md
```

本次运行结果：选中 7/277 页，平均分 93，7 页的 `quality.publishable` 都为 `true`；评估状态仍为 `failed`，因为机械内容检查报告 4 项

四项分别是 Chapter 2 第 1 页和第 37 页的 `TEACHING_EXPLANATION_TOO_SHORT`，以及第 6 页和第 41 页的 `TEACHING_REPETITION_TOO_HIGH`。这说明可发布标记与快速评测器的内容规则结果是两个不同字段

| 旧页 | 分数 | 检查结果 |
|---|---:|---|
| Introduction 18 | 100 | 无问题 |
| Introduction 20 | 100 | 无问题 |
| Chapter 2 第 1 页 | 88 | `TEACHING_EXPLANATION_TOO_SHORT` |
| Chapter 2 第 6 页 | 88 | `TEACHING_REPETITION_TOO_HIGH` |
| Chapter 2 第 9 页 | 100 | 无问题 |
| Chapter 2 第 37 页 | 88 | `TEACHING_EXPLANATION_TOO_SHORT` |
| Chapter 2 第 41 页 | 88 | `TEACHING_REPETITION_TOO_HIGH` |

评估器的退出码为 1，因为发现内容问题；这不是生成失败，也不是 Slim 候选评估结果。输入快照有 11 个发布、277 页，结果中的成本记录为 1 条且估算和实际金额均为 0；本次仅调用本地评估器，没有调用模型或服务

结果文件：`var/eval/slim-teaching-quality-fixed-11.json`、`var/eval/slim-teaching-quality-fixed-11.md`

## 来源取得与 JSON 字段

导入逻辑在 `scripts/seed-ee680.ts`：环境变量 `EE680_SOURCE_DIR` 指向仓库外素材目录；脚本读取 Introduction 与 Chapter 2 的 PDF、对应的 `高质量讲解.md` 和逐页 PNG。PNG 存入 `var/cas`，页面以 `imageUrl` 保存其内容哈希；`manifest.sourceHashes` 记录 PDF 与 Markdown 哈希，`pageHashes` 记录页面对象哈希

本基准从离线快照读取这些字段：

- `releases[].id`、`releases[].pages[]`
- `pages[].id`、`pageNumber`、`title`、`imageUrl`
- `pages[].atoms[].kind`、`pages[].blocks[]`、`pages[].lessonSections[]`
- `pages[].quality.publishable`、`pages[].quality.issues`
- `manifests[].sourceHashes`、`pageHashes`、`explanationHashes`
- 清单的 `schemaVersion`、`seed`、`concurrency`、`maxPages`、`latestFormalPerModule`、`selection.releaseIds`、`selection.pageIds`、`tagsByPageId`

Slim 人工对照引用的本地原始来源图文件包括 `var/eval/source-18-intro.png`、`var/eval/source-20.png`、`var/eval/source-9-chapter2.png`、`var/eval/source-37.png` 和 `var/eval/source-46-chapter2.png`。旧版复杂图页面 Chapter 2 第 41 页的本地图像路径为 `var/cas/f2/30/f230f593828d3026652cf674a7f2a3bb5b2a394a1b2f44ebd3ea867921c77150`

## 尚缺证据

- 没有原始 11 类的逐项证据清单供核对；本表严格按当前请求的类别名称映射
- 当前样本不能确认“纯文字”来源页；`var/readweave-course-store.json` 与 `var/live-releases.json` 中的归档页都有图像链接。仓库外原始 Markdown 是否另含纯文字页面，当前目录证据不能回答
- 本地归档没有独立代码页；检查到的原子类型包括 `pseudocode_line`，没有代码原子。较新的讲解快照虽有若干 `text` 围栏，内容仍是算法步骤，不足以证明原始来源或教学页有独立的编程语言代码样本
- UbD 历史失败页的正文只在此前记录中通过本地服务读回；当前仓库保存了截图 `var/slim-eddb1bb-browser-ubd5.png`、摘要和内容哈希，没有可供 `eval:teaching:fast` 读取的完整候选页 JSON，也没有旧正式页作为回归基线
- `EE680_SOURCE_DIR` 的示例路径不是实际来源路径；原始 PDF、Markdown 与完整逐页 PNG 的当前所在位置和版本需由本地素材持有人确认
- 本次质量分数来自旧 `full-v3` 归档页，只说明旧样本通过或触发哪些规则；没有 Slim 正文快照就不能据此宣称 Slim 通过或回归
