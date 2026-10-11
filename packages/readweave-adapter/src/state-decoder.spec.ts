import { createHash, randomBytes } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { encodeReadWeaveStateContent } from "./etapi.js";
import { withReadBudget } from "./read-budget.js";
import { decodeReadWeaveStateContentAsync, decodeReadWeaveCostRootAsync, projectReadWeaveCostRoot } from "./state-decoder.js";

const observedWorkerOptions = vi.hoisted(() => [] as (import("node:worker_threads").WorkerOptions | undefined)[]);
vi.mock("node:worker_threads", async importOriginal => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return { ...actual, Worker: class extends actual.Worker {
    constructor(filename: ConstructorParameters<typeof actual.Worker>[0], options?: import("node:worker_threads").WorkerOptions) {
      observedWorkerOptions.push(options);
      super(filename, options);
    }
  } };
});

it("cost DTO projects only after complete codec and JSON validation and retains every cost field", async () => {
  const root = {
    projections: { courseRootNoteId: "workspace", stateNoteId: "state", courses: {}, costIndexNoteId: "ledger" },
    releases: [{ id: "material", pageIds: ["retired", "page"], pages: [{ id: "page", body: "not transferred" }] }],
    drafts: [{ pageId: "draft-only", sourceReleaseId: "material", page: { body: "not transferred" } }],
    costEntries: [{ id: "duplicate", pageId: "A", nested: { value: "中文😀", extra: true } },
      { id: "duplicate", pageId: "B", opaque: "retain complete costs" }],
    researchArchives: [{ content: randomBytes(1_200_000).toString("base64") }]
  };
  const expected = projectReadWeaveCostRoot(root);
  const encoded = encodeReadWeaveStateContent(root);
  expect(Buffer.byteLength(encoded)).toBeGreaterThan(1_000_000);
  const dto = await decodeReadWeaveCostRootAsync(encoded);
  expect(dto).toEqual(expected);
  expect(dto.costEntries).toEqual(root.costEntries);
  expect(dto.releases).toEqual([{ id: "material", pageIds: ["retired", "page"], pages: [{ id: "page" }] }]);
  expect(dto.drafts).toEqual([{ pageId: "draft-only", sourceReleaseId: "material" }]);
  expect(Object.keys(dto)).toEqual(["kind", "projections", "releases", "drafts", "costEntries", "metadataReceiptKinds", "metadataRootFieldsAreEmpty"]);
  const tampered = encoded.replace(/^(COURSE_OS_BR_STATE_V1:)([a-f0-9])/u, (_match, prefix: string, digit: string) => `${prefix}${digit === "0" ? "1" : "0"}`);
  await expect(decodeReadWeaveCostRootAsync(tampered)).rejects.toThrow("READWEAVE_STATE_CODEC_HASH_MISMATCH");
  await expect(decodeReadWeaveCostRootAsync(JSON.stringify(root).slice(0, -1))).rejects.toThrow("READWEAVE_STATE_JSON_INVALID");
  await expect(decodeReadWeaveCostRootAsync("{}")).rejects.toThrow("READWEAVE_COURSE_INDEX_INVALID");
});

it("cost DTO preserves exact metadata emptiness including null and permanent-delete exceptions", () => {
  const base = { projections: { courseRootNoteId: "root", stateNoteId: "state", courses: {} } };
  const changes: Array<[Record<string, unknown>, boolean]> = [
    [{}, true], [{ courses: null, treeNodes: null, trash: null, idempotency: null }, true],
    [{ idempotency: { a: { kind: "permanent_delete" }, b: { kind: "draft_source" }, c: { kind: "cost_entry" } } }, true],
    ...["course", "tree_node", "trash", "restore", "native_erase_preflight"].map(kind => [{ idempotency: { a: { kind } } }, true] as [Record<string, unknown>, boolean]),
    [{ courses: [{}] }, false], [{ treeNodes: [{}] }, false], [{ trash: [{}] }, false],
    [{ projections: { ...base.projections, rootMaterialsNoteId: null } }, false],
    [{ projections: { ...base.projections, trashNoteId: null } }, false],
    [{ projections: { ...base.projections, rootMaterialsNoteId: "" } }, false],
    [{ projections: { ...base.projections, materialReleaseSelections: { material: {} } } }, false],
    [{ projections: { ...base.projections, courses: { course: {} } } }, false]
  ];
  for (const [change, empty] of changes) expect(projectReadWeaveCostRoot({ ...base, ...change }).metadataRootFieldsAreEmpty).toBe(empty);
  expect(projectReadWeaveCostRoot({ ...base, idempotency: { a: { kind: "course" }, b: { kind: "permanent_delete" } } }).metadataReceiptKinds).toEqual(["course", "permanent_delete"]);
  const inherited = Object.create({ hidden: { kind: "course" } });
  Object.defineProperty(inherited, "__proto__", { value: { kind: "permanent_delete" }, enumerable: true });
  inherited[Symbol("not-in-Object.values")] = { kind: "course" };
  expect(projectReadWeaveCostRoot({ ...base, idempotency: inherited }).metadataRootFieldsAreEmpty).toBe(true);
});

it("cost DTO cancellation/deadline releases its worker and a later read succeeds", async () => {
  const root = { projections: { courseRootNoteId: "root", stateNoteId: "state" },
    researchArchives: [{ content: randomBytes(1_200_000).toString("base64") }] };
  const content = encodeReadWeaveStateContent(root);
  const controller = new AbortController();
  const pending = withReadBudget({ signal: controller.signal }, () => decodeReadWeaveCostRootAsync(content));
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort();
  await expect(pending).rejects.toThrow("READ_CANCELLED");
  await expect(withReadBudget({ timeoutMs: 0 }, () => decodeReadWeaveCostRootAsync(content))).rejects.toThrow("READ_DEADLINE_EXCEEDED");
  await expect(decodeReadWeaveCostRootAsync(content)).resolves.toEqual(projectReadWeaveCostRoot(root));
  const raw = Buffer.concat([Buffer.from('{"projections":{"courseRootNoteId":"root","stateNoteId":"state"},"ignored":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  const oldPlain = raw.toString("utf8");
  const encoded = `COURSE_OS_BR_STATE_V1:${createHash("sha256").update(oldPlain).digest("hex")}:${brotliCompressSync(raw).toString("base64")}`;
  await expect(decodeReadWeaveCostRootAsync(encoded)).resolves.toEqual(projectReadWeaveCostRoot(JSON.parse(oldPlain)));
});

function makeLargeEncodedState(): { encoded: string; payload: string } {
  const payload = randomBytes(2_500_000).toString("base64");
  const encoded = encodeReadWeaveStateContent({ schemaVersion: "1.0.0", marker: "large-worker-state", payload });
  if (Buffer.byteLength(encoded) <= 1_000_000) throw new Error("test state did not exceed the worker threshold");
  return { encoded, payload };
}

it("PA18 fee pipeline applies young-generation 64 only to large cost DTO workers", async () => {
  observedWorkerOptions.length = 0;
  try {
    const root = { projections: { courseRootNoteId: "root", stateNoteId: "state" },
      costEntries: [{ id: "kept", nested: { text: "中文😀" } }], payload: randomBytes(1_200_000).toString("base64") };
    const large = encodeReadWeaveStateContent(root);
    expect(Buffer.byteLength(large)).toBeGreaterThan(1_000_000);
    await expect(decodeReadWeaveCostRootAsync(large)).resolves.toEqual(projectReadWeaveCostRoot(root));
    expect(observedWorkerOptions[0]?.resourceLimits).toEqual({ maxYoungGenerationSizeMb: 64 });
    await expect(decodeReadWeaveStateContentAsync(large)).resolves.toEqual(root);
    expect(observedWorkerOptions[1]?.resourceLimits).toBeUndefined();
    const small = { projections: root.projections, costEntries: root.costEntries };
    await expect(decodeReadWeaveCostRootAsync(JSON.stringify(small))).resolves.toEqual(projectReadWeaveCostRoot(small));
    expect(observedWorkerOptions[2]?.resourceLimits).toBeUndefined();
  } finally { observedWorkerOptions.length = 0; }
});

it("decodes a large compressed state off-thread and keeps the event loop responsive", async () => {
  const { encoded, payload } = makeLargeEncodedState();
  let heartbeats = 0;
  const heartbeat = setInterval(() => { heartbeats += 1; }, 1);
  let decoded: unknown;
  try {
    decoded = await decodeReadWeaveStateContentAsync(encoded);
  } finally {
    clearInterval(heartbeat);
  }

  expect(decoded).toMatchObject({ schemaVersion: "1.0.0", marker: "large-worker-state", payload });
  expect(heartbeats).toBeGreaterThan(0);
  const tampered = encoded.replace(/^(COURSE_OS_BR_STATE_V1:)([a-f0-9])/u, (_match, prefix: string, digit: string) => `${prefix}${digit === "0" ? "1" : "0"}`);
  await expect(decodeReadWeaveStateContentAsync(tampered)).rejects.toThrow("READWEAVE_STATE_CODEC_HASH_MISMATCH");
});

it("terminates a large decode on cancellation and allows a fresh decode", async () => {
  const { encoded, payload } = makeLargeEncodedState();
  const controller = new AbortController();
  const pending = withReadBudget({ signal: controller.signal }, () => decodeReadWeaveStateContentAsync(encoded));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  controller.abort();

  await expect(pending).rejects.toThrow("READ_CANCELLED");
  await expect(decodeReadWeaveStateContentAsync(encoded)).resolves.toMatchObject({
    schemaVersion: "1.0.0",
    marker: "large-worker-state",
    payload
  });
});

it("transfers every nested JSON field without changing Unicode, numeric values or property keys", async () => {
  const state = JSON.parse('{"__proto__":{"synthetic":true},"negativeZero":0}') as any;
  state.payload = randomBytes(1_300_000).toString("base64");
  state.releases = Array.from({ length: 600 }, (_, index) => ({ id: `release-${index}`, pages: [
    { id: `page-${index}`, pageNumber: index + 1, title: "注意力 Attention", text: "中文、é、😀、\\、\"、\n", values: [null, true, false, 0, 1e300, -1e-300] }
  ] }));
  state.projections = { drafts: { first: { blockHashes: { "课程": "confirmed" } } }, courses: ["one", "two"] };
  state.costEntries = [{ id: "cost-one", total: 17 }, { id: "cost-two", total: 23 }];
  const text = JSON.stringify(state).replace('"negativeZero":0', '"negativeZero":-0');
  const expected = JSON.parse(text);
  const decoded = await decodeReadWeaveStateContentAsync(text) as any;
  expect(decoded).toEqual(expected);
  expect(Object.is(decoded.negativeZero, -0)).toBe(true);
  expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  const compressed = encodeReadWeaveStateContent(expected);
  expect(Buffer.byteLength(compressed)).toBeGreaterThan(1_000_000);
  await expect(decodeReadWeaveStateContentAsync(compressed)).resolves.toEqual(JSON.parse(JSON.stringify(expected)));
});

it("preserves the legacy replacement-string checksum for malformed UTF-8 content", async () => {
  const raw = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  const oldPlain = raw.toString("utf8");
  const encoded = `COURSE_OS_BR_STATE_V1:${createHash("sha256").update(oldPlain).digest("hex")}:${brotliCompressSync(raw).toString("base64")}`;
  await expect(decodeReadWeaveStateContentAsync(encoded)).resolves.toEqual(JSON.parse(oldPlain));
});
