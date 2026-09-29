import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedPagePrefetchQueue, ImageResourceCache, settlePagePrefetch } from "./reading-prefetch.js";

afterEach(() => vi.unstubAllGlobals());

describe("bounded image resources", () => {
  it("shares an in-flight load, decodes once, and retains a successful image", async () => {
    const images: FakeImage[] = [];
    vi.stubGlobal("Image", class extends FakeImage { constructor() { super(); images.push(this); } });
    const cache = new ImageResourceCache(2);

    const first = cache.load("/page-1.png", "high");
    const reused = cache.load("/page-1.png", "low");
    expect(reused).toBe(first);
    expect(images).toHaveLength(1);
    expect(images[0]?.fetchPriority).toBe("high");

    images[0]!.finish();
    await expect(first).resolves.toBe(images[0]);
    expect(images[0]?.decode).toHaveBeenCalledOnce();
    expect(cache.get("/page-1.png")?.state).toBe("ready");
    expect(cache.load("/page-1.png")).toBe(first);
  });

  it("promotes an in-flight target and preserves pending URLs while evicting settled entries first", async () => {
    const images: FakeImage[] = [];
    vi.stubGlobal("Image", class extends FakeImage { constructor() { super(); images.push(this); } });
    const cache = new ImageResourceCache(1);
    const oldRequest = cache.load("/same.png", "low");
    expect(cache.load("/same.png", "high")).toBe(oldRequest);
    expect(images[0]?.fetchPriority).toBe("high");

    const other = cache.load("/other.png", "low");
    const third = cache.load("/third.png", "high");
    await expect(cache.load("/fourth.png", "low")).rejects.toThrow("slots are still loading");
    expect(cache.size).toBe(3);
    expect(cache.get("/same.png")?.promise).toBe(oldRequest);

    images[0]!.finish();
    await oldRequest;
    const fourth = cache.load("/fourth.png", "low");
    expect(cache.get("/same.png")).toBeUndefined();
    images[3]!.finish();
    await fourth;
    images[1]!.finish();
    images[2]!.finish();
    await Promise.all([other, third]);
    expect(cache.size).toBeLessThanOrEqual(1);
  });

  it("keeps all pending high-priority images when the transient resource limit is full", async () => {
    const images: FakeImage[] = [];
    vi.stubGlobal("Image", class extends FakeImage { constructor() { super(); images.push(this); } });
    const cache = new ImageResourceCache(1);
    const pending = ["/current.png", "/next.png", "/jump.png"].map((url) => cache.load(url, "high"));

    await expect(cache.load("/neighbor.png", "low")).rejects.toThrow("slots are still loading");
    expect(cache.size).toBe(3);
    expect(cache.get("/current.png")?.promise).toBe(pending[0]);
    expect(cache.get("/next.png")?.promise).toBe(pending[1]);
    expect(cache.get("/jump.png")?.promise).toBe(pending[2]);
    expect(images).toHaveLength(3);

    images.forEach((image) => image.finish());
    await Promise.all(pending);
    expect(cache.size).toBe(1);
  });

  it("removes failed resources so a later visit can retry and keeps the map bounded", async () => {
    const images: FakeImage[] = [];
    vi.stubGlobal("Image", class extends FakeImage { constructor() { super(); images.push(this); } });
    const cache = new ImageResourceCache(2);

    const failed = cache.load("/broken.png");
    images[0]!.fail();
    await expect(failed).rejects.toThrow("Unable to load image");
    expect(cache.get("/broken.png")).toBeUndefined();

    const retry = cache.load("/broken.png");
    expect(images).toHaveLength(2);
    images[1]!.finish();
    await retry;
    const third = cache.load("/third.png");
    images[2]!.finish();
    await third;
    const fourth = cache.load("/fourth.png");
    images[3]!.finish();
    await fourth;
    expect(cache.size).toBe(2);
    expect(cache.get("/broken.png")).toBeUndefined();
  });
});

describe("bounded page prefetch", () => {
  it("makes the lesson snapshot available before a slower neighboring image", async () => {
    const snapshot = deferred<string>();
    const image = deferred<void>();
    let cached = "";
    let finished = false;
    const pending = settlePagePrefetch(snapshot.promise, image.promise, (value) => { cached = value; })
      .then(() => { finished = true; });

    snapshot.resolve("lesson ready");
    await vi.waitFor(() => expect(cached).toBe("lesson ready"));
    expect(finished).toBe(false);

    image.resolve();
    await pending;
    expect(finished).toBe(true);
  });

  it("deduplicates targets and never runs more than two page preparations at once", async () => {
    const queue = new BoundedPagePrefetchQueue(2);
    const completions: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const work = vi.fn(() => new Promise<void>((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      completions.push(() => { active -= 1; resolve(); });
    }));

    const one = queue.enqueue("page-1", work);
    const oneAgain = queue.enqueue("page-1", work, 10);
    const two = queue.enqueue("page-2", work);
    const three = queue.enqueue("page-3", work);
    expect(oneAgain).toBe(one);
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);

    completions[0]!();
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(3));
    completions[1]!();
    completions[2]!();
    await Promise.all([one, two, three]);
    expect(peak).toBe(2);
  });

  it("runs an explicitly intended page before older queued neighbors", async () => {
    const queue = new BoundedPagePrefetchQueue(1);
    const started: string[] = [];
    const completions = new Map<string, () => void>();
    const task = (id: string) => () => new Promise<void>((resolve) => {
      started.push(id);
      completions.set(id, resolve);
    });
    const current = queue.enqueue("current", task("current"));
    const neighbor = queue.enqueue("neighbor", task("neighbor"));
    const intended = queue.enqueue("intended", task("intended"), 20);
    await Promise.resolve();
    expect(started).toEqual(["current"]);

    completions.get("current")!();
    await vi.waitFor(() => expect(started).toEqual(["current", "intended"]));
    completions.get("intended")!();
    await vi.waitFor(() => expect(started).toEqual(["current", "intended", "neighbor"]));
    completions.get("neighbor")!();
    await Promise.all([current, intended, neighbor]);
  });
});

class FakeImage extends EventTarget {
  src = "";
  fetchPriority = "auto";
  decode = vi.fn(() => Promise.resolve());

  finish() { this.dispatchEvent(new Event("load")); }
  fail() { this.dispatchEvent(new Event("error")); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
