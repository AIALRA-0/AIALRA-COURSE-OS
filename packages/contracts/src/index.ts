export const COURSE_API_VERSION = "2.4.0" as const;
export const PREVIOUS_COURSE_API_VERSION = "2.3.0" as const;
export const LEGACY_COURSE_API_VERSION = "2.2.0" as const;
export const HISTORICAL_COURSE_API_VERSION = "2.1.0" as const;
export const WRITING_POLICY_SCHEMA_VERSION = "1.0.0" as const;

export type CourseApiVersion = typeof COURSE_API_VERSION | typeof PREVIOUS_COURSE_API_VERSION | typeof LEGACY_COURSE_API_VERSION | typeof HISTORICAL_COURSE_API_VERSION;

export type Identifier = string;
export type ISODateTime = string;
export type ClaimKind = "source_claim" | "supplement_claim" | "conflict_claim";
export type MasteryState = "unseen" | "introduced" | "practicing" | "mastered" | "needs_review";
export type WorkspaceMode = "studio" | "learn" | "review";
export type LessonSectionKind = "learning_objectives" | "main_content" | "prior_knowledge" | "full_explanation" | "misconceptions";
export type QuestionKind = "comprehension" | "multiple_choice";
export type GenerationStage = "extract" | "atomize" | "teach" | "review" | "repair" | "question_refill";
export type CourseTreeNodeKind = "workspace" | "course" | "module" | "material" | "section" | "release" | "page" | "trash";
export type TreeNodeCapability =
  | "create"
  | "create_course"
  | "create_module"
  | "import_material"
  | "rename"
  | "duplicate"
  | "move"
  | "reorder"
  | "trash"
  | "restore"
  | "open_studio"
  | "open_readweave"
  | "history"
  | "properties";
export type DraftStatus = "clean" | "editing" | "needs_review" | "ready" | "conflict";
export type SyncConnectionState = "connected" | "degraded" | "offline";
export type JobState =
  | "queued"
  | "running"
  | "pending_sync"
  | "completed"
  | "paused"
  | "cancelled"
  | "failed";

export interface Provenance {
  sourceMaterialVersionId: Identifier;
  pageId: Identifier;
  anchorIds: Identifier[];
  observedAt: ISODateTime;
}

export interface SourceAnchor {
  id: Identifier;
  pageId: Identifier;
  kind: "page" | "text" | "region" | "formula" | "code" | "chart" | "diagram" | "image";
  label: string;
  bounds?: { x: number; y: number; width: number; height: number };
  text?: string;
}

export interface MathExpression {
  kind: "math_expression";
  id: Identifier;
  sourceTex: string;
  normalizedTex: string;
  symbols: Array<{ symbol: string; meaning: string }>;
  parseStatus: "valid" | "invalid";
}

export interface PseudoCodeLine {
  kind: "pseudocode_line";
  id: Identifier;
  lineNumber: number;
  code: string;
  semantic: string;
  /** A complete, plain-language sentence shown before the detailed state table */
  teacherSummary?: string;
  reads: string[];
  writes: string[];
  preState: string;
  postState: string;
  sideEffects: string[];
  complexityRelation: string;
}

export interface CodeBlock {
  kind: "code_block";
  id: Identifier;
  language: string;
  code: string;
  variables: Array<{ name: string; type: string; role: string; lifetime: string }>;
  branches: string[];
  executionTrace: string[];
}

export interface ChartElement {
  kind: "chart_axis" | "chart_legend" | "chart_series";
  id: Identifier;
  label: string;
  unit?: string;
  encoding?: string;
  observation: string;
  limitation?: string;
}

export interface DiagramElement {
  kind: "diagram_node" | "diagram_edge" | "image_region";
  id: Identifier;
  label: string;
  observation: string;
  inference?: string;
}

export type TeachingAtom = MathExpression | PseudoCodeLine | CodeBlock | ChartElement | DiagramElement;

export interface CoverageRequirement {
  id: Identifier;
  atomId: Identifier;
  requiredFields: string[];
  risk: "high" | "general";
}

export interface CoverageClaim {
  requirementId: Identifier;
  explanationBlockId: Identifier;
  coveredFields: string[];
  status: "covered" | "partial" | "missing";
}

export interface ExplanationBlock {
  id: Identifier;
  title: string;
  kind:
    | "objective"
    | "prerequisite"
    | "core"
    | "example"
    | "misconception"
    | "check"
    | "deep_dive"
    | "qa"
    | "source_status";
  markdown: string;
  sourceAnchorIds: Identifier[];
  atomIds: Identifier[];
}

export interface SentenceItem {
  id: Identifier;
  text: string;
  sourceAnchorIds: Identifier[];
}

export interface LessonSection {
  id: Identifier;
  kind: LessonSectionKind;
  title: string;
  markdown?: string;
  items?: SentenceItem[];
  sourceAnchorIds: Identifier[];
  atomIds: Identifier[];
}

export interface QuestionBankItem {
  id: Identifier;
  pageId: Identifier;
  objectiveId: Identifier;
  kind: QuestionKind;
  prompt: string;
  options?: string[];
  expectedAnswer: string;
  explanation: string;
  sourceAnchorIds: Identifier[];
  status: "draft" | "approved" | "retired";
  version: number;
  generatedBy: string;
}

export interface PageLesson {
  id: Identifier;
  pageNumber: number;
  title: string;
  imageUrl: string;
  anchors: SourceAnchor[];
  atoms: TeachingAtom[];
  blocks: ExplanationBlock[];
  lessonSections?: LessonSection[];
  questionBank?: QuestionBankItem[];
  coverageRequirements: CoverageRequirement[];
  coverageClaims: CoverageClaim[];
  quality: {
    highRiskCoverage: number;
    generalCoverage: number;
    mathValid: boolean;
    publishable: boolean;
    issues: string[];
  };
}

export interface Claim {
  id: Identifier;
  kind: ClaimKind;
  text: string;
  provenance?: Provenance;
  reviewStatus: "accepted" | "needs_review" | "rejected";
}

export interface CourseRelease {
  id: Identifier;
  courseId: Identifier;
  courseTitle: string;
  moduleId: Identifier;
  moduleTitle: string;
  version: number;
  publishedAt: ISODateTime;
  pageIds: Identifier[];
  pages: PageLesson[];
  assessments: AssessmentItem[];
  manifestHash: string;
  writingPolicySnapshotId: Identifier;
  modelRoute: string;
  qualityHarnessVersion: string;
  costUsd: number;
  lifecycle?: "draft_source" | "published";
}

export interface CourseTreeNode {
  id: Identifier;
  kind: CourseTreeNodeKind;
  title: string;
  subtitle?: string;
  releaseId?: Identifier;
  pageId?: Identifier;
  pageNumber?: number;
  status?: "published" | "draft" | "needs_review" | "syncing" | "conflict";
  parentId?: Identifier;
  revision?: number;
  sortOrder?: number;
  archived?: boolean;
  visibility?: "library" | "internal" | "archived";
  materialId?: Identifier;
  currentReleaseId?: Identifier;
  pageCount?: number;
  capabilities?: TreeNodeCapability[];
  readweaveNoteId?: Identifier;
  readweaveUrl?: string;
  children: CourseTreeNode[];
}

export interface WorkspaceTree {
  workspaceId: Identifier;
  title: string;
  treeVersion?: "2.4.0";
  courses: CourseTreeNode[];
  /** Materials restored directly to the workspace root are shown beside courses */
  rootMaterials?: CourseTreeNode[];
  trash?: CourseTreeNode;
  updatedAt: ISODateTime;
}

export interface TreeNodeProperties {
  nodeId: Identifier;
  kind: CourseTreeNodeKind;
  title: string;
  subtitle?: string;
  revision: number;
  sortOrder?: number;
  readweaveNoteId?: Identifier;
  readweaveUrl?: string;
  syncState: SyncConnectionState;
  pageCount?: number;
  sourceReleaseId?: Identifier;
  updatedAt?: ISODateTime;
}

export interface CourseProject {
  id: Identifier;
  workspaceId: Identifier;
  title: string;
  description?: string;
  status: "active" | "archived";
  readweaveNoteId?: Identifier;
  revision?: number;
  sortOrder?: number;
  archivedAt?: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface LessonDraft {
  id: Identifier;
  workspaceId: Identifier;
  courseId: Identifier;
  moduleId: Identifier;
  sourceReleaseId: Identifier;
  pageId: Identifier;
  revision: number;
  status: DraftStatus;
  page: PageLesson;
  changedBlockIds: Identifier[];
  readweaveNoteId?: Identifier;
  contentHash: string;
  updatedAt: ISODateTime;
}

export interface QualityValidationResult {
  pageId: Identifier;
  draftId: Identifier;
  revision: number;
  publishable: boolean;
  highRiskCoverage: number;
  generalCoverage: number;
  mathValid: boolean;
  pseudocodeLines: number;
  explainedPseudocodeLines: number;
  issues: string[];
  checkedAt: ISODateTime;
}

export interface ReadWeaveSyncStatus {
  state: SyncConnectionState;
  authority: "readweave";
  mode: "file" | "http" | "etapi";
  pendingWrites: number;
  conflicts: number;
  lastReadAt?: ISODateTime;
  lastWriteAt?: ISODateTime;
  deepLinkBase?: string;
  message: string;
}

export interface CourseConflict {
  id: Identifier;
  workspaceId: Identifier;
  objectId: Identifier;
  objectType: "lesson_draft" | "release" | "question" | "mastery";
  baseRevision: number;
  localRevision: number;
  remoteRevision: number;
  baseContent: string;
  localContent: string;
  remoteContent: string;
  status: "open" | "resolved";
  resolution?: "local" | "remote" | "merged";
  createdAt: ISODateTime;
  resolvedAt?: ISODateTime;
}

export interface WritingPolicySnapshot {
  id: Identifier;
  schemaVersion: typeof WRITING_POLICY_SCHEMA_VERSION;
  createdAt: ISODateTime;
  sourceFiles: Array<{ path: string; sha256: string }>;
  aggregateSha256: string;
  approved: boolean;
}

export interface ResearchArchive {
  id: Identifier;
  version: number;
  title: string;
  content: string;
  sha256: string;
  byteCount: number;
  characterCount: number;
  lineCount: number;
  sourceDate: string;
  gitPath: string;
  immutable: true;
  createdAt: ISODateTime;
}

export interface ImportRecord {
  id: Identifier;
  workspaceId: Identifier;
  courseId?: Identifier;
  parentNodeId?: Identifier;
  originalName: string;
  mediaType: string;
  kind: "pptx" | "pdf" | "syllabus";
  sizeBytes: number;
  sha256: string;
  casPath: string;
  source: string;
  license: string;
  qualityMode?: "economy" | "balanced" | "quality";
  language?: string;
  sensitivity: "private" | "restricted" | "public";
  state: "quarantined" | "accepted" | "processing" | "syncing" | "ready" | "rejected" | "failed";
  issues: string[];
  materialVersionId?: Identifier;
  pageIds?: Identifier[];
  draftIds?: Identifier[];
  convertedAt?: ISODateTime;
  createdAt: ISODateTime;
}

export interface DraftSourceAsset {
  sha256: string;
  fileName: string;
  mediaType: "image/png" | "image/svg+xml";
  bytes: Uint8Array;
}

export interface ConversionRequest {
  id: Identifier;
  sourcePath: string;
  originalName: string;
  kind: "pptx" | "pdf" | "syllabus";
  outputDir: string;
  createdAt: ISODateTime;
}

export interface ConvertedPage {
  pageNumber: number;
  title: string;
  text: string;
  imagePath: string;
  imageMediaType: "image/png" | "image/svg+xml";
}

export interface ConversionResult {
  requestId: Identifier;
  state: "completed" | "failed";
  pages: ConvertedPage[];
  issues: string[];
  startedAt: ISODateTime;
  completedAt: ISODateTime;
}

export interface OrderedEvent<T = unknown> {
  id: number;
  streamId: Identifier;
  type: string;
  occurredAt: ISODateTime;
  payload: T;
}

export interface GenerationJob {
  id: Identifier;
  workspaceId: Identifier;
  materialVersionId: Identifier;
  state: JobState;
  budgetUsd: number;
  spentUsd: number;
  pageIds: Identifier[];
  completedPageIds: Identifier[];
  failedPageIds: Identifier[];
  attempt: number;
  cancelRequested: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface LearningSession {
  id: Identifier;
  /** Workspace ownership is optional for reading sessions created before 2.4.0 */
  workspaceId?: Identifier;
  courseReleaseId: Identifier;
  currentPageId: Identifier;
  currentAnchorId?: Identifier;
  explanationScroll: number;
  zoom: number;
  panX: number;
  panY: number;
  updatedAt: ISODateTime;
}

export interface PageQuestion {
  id: Identifier;
  sessionId: Identifier;
  courseReleaseId: Identifier;
  pageId: Identifier;
  anchorIds: Identifier[];
  learnerAttempt: string;
  question: string;
  hintLevel: 1 | 2 | 3 | 4 | 5 | 6;
  response: string;
  reviewPolicy: "include" | "exclude";
  status: "active" | "retracted";
  revision: number;
  readweaveNoteId?: Identifier;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface QuestionSelection {
  id: Identifier;
  sessionId: Identifier;
  courseReleaseId: Identifier;
  pageId: Identifier;
  seed: string;
  questionIds: Identifier[];
  createdAt: ISODateTime;
}

export interface QuestionAttempt {
  id: Identifier;
  selectionId: Identifier;
  sessionId: Identifier;
  courseReleaseId: Identifier;
  pageId: Identifier;
  questionId: Identifier;
  objectiveId: Identifier;
  answer: string;
  correct: boolean;
  usedHintLevel: number;
  misconception?: string;
  attemptedAt: ISODateTime;
}

export interface UnitPriceSnapshot {
  id: Identifier;
  provider: string;
  model: string;
  currency: "USD";
  capturedAt: ISODateTime;
  source: string;
  inputMicrousdPerMillion: number;
  outputMicrousdPerMillion: number;
  cachedInputMicrousdPerMillion: number;
}

export type CostBasis = "provider_reported" | "price_snapshot" | "not_available";

export interface GenerationCostEntry {
  id: Identifier;
  workspaceId: Identifier;
  courseId: Identifier;
  materialVersionId: Identifier;
  pageId?: Identifier;
  objectId?: Identifier;
  jobId: Identifier;
  stage: GenerationStage;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  unitPriceSnapshot: UnitPriceSnapshot;
  estimatedMicrousd: number;
  actualMicrousd: number;
  durationMs: number;
  retries: number;
  status: "succeeded" | "failed" | "cancelled";
  qualityPassed: boolean;
  billingMode?: BillingMode;
  cashCostMicrousd?: number;
  quotaConsumedMicrousd?: number;
  estimatedCashCostMicrousd?: number;
  estimatedQuotaConsumedMicrousd?: number;
  costBasis?: CostBasis;
  createdAt: ISODateTime;
}

export type BillingMode = "metered" | "subscription_quota" | "free" | "unknown";

export interface TreeNodeRevision {
  nodeId: Identifier;
  revision: number;
  updatedAt: ISODateTime;
}

export interface TrashRecord {
  id: Identifier;
  workspaceId: Identifier;
  nodeId: Identifier;
  nodeKind: CourseTreeNodeKind;
  title: string;
  parentId?: Identifier;
  originalParentId?: Identifier;
  originalSortOrder?: number;
  originalPath?: string[];
  restoreMode?: "original" | "root";
  snapshotHash?: string;
  readweaveNoteId?: Identifier;
  deletedAt: ISODateTime;
  deletedBy: string;
  restoreAvailable: boolean;
  permanentDeleteRequested?: boolean;
}

export interface ReadWeaveDeepLink {
  noteId: Identifier;
  url: string;
  host: string;
  verified: boolean;
  verifiedAt?: ISODateTime;
}

export interface WorkspaceSettings {
  workspaceId: Identifier;
  language: "zh-CN" | "en";
  theme: "light" | "dark" | "system";
  baseFontScale: 1 | 1.1 | 1.2 | 1.3;
  defaultQualityMode: "economy" | "balanced" | "quality";
  learningAutoAdvance: boolean;
  showEnglishLabels: boolean;
  updatedAt: ISODateTime;
}

export type ModelProtocol = "responses" | "messages" | "chat_completions";

export interface ModelCapability {
  id: Identifier;
  displayName: string;
  protocol: ModelProtocol;
  supportsVision: boolean;
  supportsJsonSchema: boolean;
  supportsReasoning: boolean;
  billingMode: BillingMode;
}

export interface CredentialStatus {
  configured: boolean;
  maskedValue?: string;
  updatedAt?: ISODateTime;
}

export interface ProviderHealth {
  providerId: Identifier;
  state: "connected" | "degraded" | "offline" | "unconfigured";
  checkedAt: ISODateTime;
  message: string;
}

export interface ModelProviderConfig {
  id: Identifier;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
  credential: CredentialStatus;
  models: ModelCapability[];
  health?: ProviderHealth;
}

export interface ModelRouteRule {
  stage: GenerationStage | "qa";
  providerId: Identifier;
  modelId: Identifier;
  fallbackProviderId?: Identifier;
  fallbackModelId?: Identifier;
  enabled: boolean;
}

export interface ModelRoutePolicy {
  workspaceId: Identifier;
  rules: ModelRouteRule[];
  allowAialraEmergencyFallback: boolean;
  updatedAt: ISODateTime;
}

export interface CostRollup {
  scope: "workspace" | "course" | "material" | "page" | "job";
  scopeId: Identifier;
  actualMicrousd: number;
  estimatedMicrousd: number;
  cashCostMicrousd: number;
  quotaConsumedMicrousd: number;
  estimatedCashCostMicrousd: number;
  estimatedQuotaConsumedMicrousd: number;
  callCount: number;
  byStage: Array<{ stage: GenerationStage; actualMicrousd: number; calls: number }>;
  byModel: Array<{ model: string; actualMicrousd: number; calls: number }>;
}

export interface AssessmentItem {
  id: Identifier;
  objectiveId: Identifier;
  pageId: Identifier;
  prompt: string;
  expectedAnswer: string;
  transfer: boolean;
}

export interface AssessmentAttempt {
  id: Identifier;
  itemId: Identifier;
  objectiveId: Identifier;
  answer: string;
  correct: boolean;
  usedHintLevel: number;
  misconception?: string;
  attemptedAt: ISODateTime;
}

export interface MasteryRecord {
  objectiveId: Identifier;
  state: MasteryState;
  unaidedCorrect: boolean;
  delayedOrTransferCorrect: boolean;
  nextReviewAt?: ISODateTime;
  intervalStep: number;
  algorithmVersion: "review-ladder-v1";
  updatedAt: ISODateTime;
}

export interface ReviewObjective {
  objectiveId: Identifier;
  objectiveText: string;
  courseId: Identifier;
  courseTitle: string;
  moduleId: Identifier;
  moduleTitle: string;
  releaseId: Identifier;
  pageId: Identifier;
  pageNumber: number;
  pageTitle: string;
  state: MasteryState;
  unaidedCorrect: boolean;
  delayedOrTransferCorrect: boolean;
  nextReviewAt?: ISODateTime;
  intervalStep: number;
  due: boolean;
  attemptCount: number;
  hintDependencyCount: number;
  lastMisconception?: string;
  lastAttemptAt?: ISODateTime;
}

export interface ReviewMap {
  generatedAt: ISODateTime;
  releaseCount: number;
  pageCount: number;
  objectives: ReviewObjective[];
  summary: {
    total: number;
    due: number;
    unseen: number;
    introduced: number;
    practicing: number;
    mastered: number;
    needsReview: number;
  };
}

export type ReviewSessionSource = "due" | "manual";
export type ReviewSessionStatus = "active" | "completed" | "cancelled";

export type ReviewPlanStatus = "preparing" | "ready" | "sync_pending" | "failed" | "cancelled" | "started";
export type ReviewPlanItemStatus = "ready" | "needs_generation" | "failed";

export interface ReviewPlanCost {
  estimatedMicrousd: number;
  actualMicrousd: number;
  cashCostMicrousd: number;
  quotaConsumedMicrousd: number;
  reusedQuestionCount: number;
  generatedQuestionCount: number;
}

export interface ReviewPlanItem {
  objectiveId: Identifier;
  releaseId: Identifier;
  pageId: Identifier;
  questionIds: Identifier[];
  reusedQuestionIds: Identifier[];
  generatedQuestionIds: Identifier[];
  status: ReviewPlanItemStatus;
  error?: string;
}

export interface ReviewPlan {
  id: Identifier;
  workspaceId: Identifier;
  source: ReviewSessionSource;
  seed: string;
  objectiveIds: Identifier[];
  items: ReviewPlanItem[];
  budgetUsd: number;
  cost: ReviewPlanCost;
  status: ReviewPlanStatus;
  syncState: SyncConnectionState;
  revision: number;
  readweaveNoteId?: Identifier;
  error?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  startedAt?: ISODateTime;
}

export interface ReviewSession {
  id: Identifier;
  workspaceId: Identifier;
  source: ReviewSessionSource;
  seed: string;
  objectiveIds: Identifier[];
  reviewPlanId?: Identifier;
  questionIdsByObjective?: Record<Identifier, Identifier[]>;
  currentIndex: number;
  status: ReviewSessionStatus;
  currentObjectiveId?: Identifier;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  completedAt?: ISODateTime;
}

export interface ReviewAttemptResult {
  attempt: QuestionAttempt | AssessmentAttempt;
  mastery: MasteryRecord;
  feedback: string;
  nextObjectiveId?: Identifier;
}

export interface ReleaseManifest {
  id: Identifier;
  schemaVersion: CourseApiVersion;
  courseReleaseId: Identifier;
  sourceHashes: string[];
  pageHashes: string[];
  explanationHashes: string[];
  assessmentHashes: string[];
  writingPolicySnapshotId: Identifier;
  modelRoutes: string[];
  qualityHarnessVersion: string;
  costInputs: Array<{ provider: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }>;
  costEntryIds?: Identifier[];
  totalCostMicrousd?: number;
  createdAt: ISODateTime;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    details?: unknown;
  };
}

export interface IdempotentWriteContext {
  idempotencyKey: string;
  actor: string;
  workspaceId: string;
  schemaVersion: CourseApiVersion;
  requestId: string;
}
