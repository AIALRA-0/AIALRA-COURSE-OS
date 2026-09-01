import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CourseRelease, IdempotentWriteContext, PageLesson, ReleaseManifest } from "@course-os/contracts";
import { COURSE_API_VERSION } from "@course-os/contracts";
import { hashManifest, sha256Text, stableStringify } from "@course-os/domain";
import { FileReadWeaveCourseApi } from "@course-os/readweave-adapter";
import { ContentAddressedStore } from "@course-os/storage";

const dataDir = resolve(process.env.COURSE_OS_DATA_DIR || "./var");
const cas = new ContentAddressedStore(resolve(dataDir, "cas"));
const readweave = new FileReadWeaveCourseApi(resolve(dataDir, "readweave-course-store.json"));
const image = await cas.put(await readFile(resolve("docs/assets/synthetic-binary-search-slide.svg")));
const pageId = "synthetic-binary-search-v1:page:1";
const atomId = `${pageId}:diagram:sorted-array`;
const requirementId = `${pageId}:requirement:diagram`;
const page: PageLesson = {
  id: pageId,
  pageNumber: 1,
  title: "Binary Search：为什么每次能排除一半",
  imageUrl: `/api/v1/media/${image.sha256}`,
  anchors: [{ id: `${pageId}:anchor:array`, pageId, kind: "diagram", label: "有序数组与 middle 指针" }],
  atoms: [{ kind: "diagram_node", id: atomId, label: "有序数组与 middle", observation: "数组从小到大排列，middle 指向当前搜索区间的中间元素", inference: "有序性保证比较后可以安全排除一半候选" }],
  blocks: [
    { id: `${pageId}:objective`, title: "本页学完要做到什么", kind: "objective", markdown: "能解释二分查找维持的搜索区间，并预测每次比较后哪一半可以排除", sourceAnchorIds: [`${pageId}:anchor:array`], atomIds: [atomId] },
    { id: `${pageId}:prerequisite`, title: "先补齐这些知识", kind: "prerequisite", markdown: "先知道数组下标、升序排列，以及区间左边界和右边界", sourceAnchorIds: [`${pageId}:anchor:array`], atomIds: [atomId] },
    { id: `${pageId}:core`, title: "老师完整讲解", kind: "core", markdown: "二分查找不是盲目猜中间值，而是在维护一个不变量：目标如果存在，就一定还在当前闭区间 $[left,right]$ 中\n\n取 $mid=\\lfloor(left+right)/2\\rfloor$ 后，如果 $array[mid] < target$，由于数组有序，$mid$ 左侧的值都不会等于目标，所以令 $left=mid+1$", sourceAnchorIds: [`${pageId}:anchor:array`], atomIds: [atomId] },
    { id: `${pageId}:example`, title: "跟着做一个完整例子", kind: "example", markdown: "在 `[2,5,8,12,16,23,31]` 中查找 `23`，第一次中间值是 `12`，目标更大，所以保留 `[16,23,31]`；第二次中间值是 `23`，查找成功", sourceAnchorIds: [`${pageId}:anchor:array`], atomIds: [atomId] },
    { id: `${pageId}:mistake`, title: "最容易错在哪里", kind: "misconception", markdown: "把左边界更新成 `mid` 会让区间可能不再缩小；排除已经比较过的中间元素时必须使用 `mid+1` 或 `mid-1`", sourceAnchorIds: [`${pageId}:anchor:array`], atomIds: [atomId] },
    { id: `${pageId}:check`, title: "现在检查是否真的理解", kind: "check", markdown: "如果中间值小于目标，应该修改哪个边界，为什么不能保留中间元素", sourceAnchorIds: [`${pageId}:anchor:array`], atomIds: [atomId] },
    { id: `${pageId}:deep`, title: "逐变量与边界细节", kind: "deep_dive", markdown: "`left` 是仍可能包含目标的最小下标，`right` 是最大下标，`mid` 只用于本轮比较\n\n循环终止条件 `left > right` 表示候选区间为空，能够证明目标不存在", sourceAnchorIds: [`${pageId}:anchor:array`], atomIds: [atomId] },
    { id: `${pageId}:qa`, title: "课堂问答", kind: "qa", markdown: "- 问：为什么必须先排序？答：没有顺序就无法由一次比较推出整半区都不可能包含目标\n- 问：时间复杂度为什么是 $O(\\log n)$？答：每轮把候选数量最多缩小到原来的一半", sourceAnchorIds: [`${pageId}:anchor:array`], atomIds: [atomId] },
    { id: `${pageId}:source`, title: "来源状态", kind: "source_status", markdown: "本页使用仓库内合成材料，只用于验证公开演示和 README，不代表 EE680 私有课程内容", sourceAnchorIds: [`${pageId}:anchor:array`], atomIds: [atomId] }
  ],
  coverageRequirements: [{ id: requirementId, atomId, requiredFields: ["label", "observation"], risk: "general" }],
  coverageClaims: [{ requirementId, explanationBlockId: `${pageId}:deep`, coveredFields: ["label", "observation"], status: "covered" }],
  quality: { highRiskCoverage: 1, generalCoverage: 1, mathValid: true, publishable: true, issues: [] }
};
const assessment = { id: `${pageId}:assessment:recall`, objectiveId: `${pageId}:objective`, pageId, prompt: "中间值小于目标时，应该更新哪个边界", expectedAnswer: "左边界", transfer: false };
const manifest: ReleaseManifest = {
  id: "synthetic-binary-search-v1:manifest", schemaVersion: COURSE_API_VERSION, courseReleaseId: "synthetic-binary-search-v1",
  sourceHashes: [image.sha256], pageHashes: [sha256Text(stableStringify(page))], explanationHashes: page.blocks.map((block) => sha256Text(stableStringify(block))),
  assessmentHashes: [sha256Text(stableStringify(assessment))], writingPolicySnapshotId: "synthetic-policy-v1", modelRoutes: ["deterministic-synthetic-v1"], qualityHarnessVersion: "synthetic-smoke-v1", costInputs: [], createdAt: "2026-08-28T12:00:00.000Z"
};
const release: CourseRelease = {
  id: "synthetic-binary-search-v1", courseId: "synthetic-algorithms", courseTitle: "Synthetic Algorithms",
  moduleId: "binary-search", moduleTitle: "Synthetic Binary Search", version: 1, publishedAt: "2026-08-28T12:00:00.000Z",
  pageIds: [page.id], pages: [page], assessments: [assessment],
  manifestHash: hashManifest(manifest), writingPolicySnapshotId: "synthetic-policy-v1", modelRoute: "deterministic-synthetic-v1", qualityHarnessVersion: "synthetic-smoke-v1", costUsd: 0
};
const context: IdempotentWriteContext = { idempotencyKey: "seed:synthetic-binary-search-v1", actor: "synthetic-seed", workspaceId: "personal", schemaVersion: COURSE_API_VERSION, requestId: "seed:synthetic-binary-search-v1" };
await readweave.publishRelease(release, manifest, context);
process.stdout.write("Published synthetic-binary-search-v1\n");
