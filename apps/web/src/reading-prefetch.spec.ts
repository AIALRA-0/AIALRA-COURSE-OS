import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedPagePrefetchQueue, ImageResourceCache, settlePagePrefetch } from "./reading-prefetch.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

  it("times out a hung image load, removes listeners, and allows a fresh retry", async () => {
    vi.useFakeTimers();
    const images: FakeImage[] = [];
    vi.stubGlobal("Image", class extends FakeImage { constructor() { super(); images.push(this); } });
    const cache = new ImageResourceCache(2);
    const first = cache.load("/slow.png");
    const firstResource = cache.get("/slow.png")!;
    const firstFailure = expect(first).rejects.toThrow("Timed out loading image");

    await vi.advanceTimersByTimeAsync(10_000);
    await firstFailure;
    expect(cache.get("/slow.png")).toBeUndefined();
    expect(firstResource.state).toBe("error");
    expect(images[0]!.src).toBe("");
    images[0]!.finish();
    expect(firstResource.state).toBe("error");
    expect(images[0]!.decode).not.toHaveBeenCalled();

    const retry = cache.load("/slow.png");
    expect(images).toHaveLength(2);
    images[1]!.finish();
    await expect(retry).resolves.toBe(images[1]);
  });

  it("applies the same deadline to image decoding", async () => {
    vi.useFakeTimers();
    const images: FakeImage[] = [];
    vi.stubGlobal("Image", class extends FakeImage { constructor() { super(); images.push(this); } });
    const cache = new ImageResourceCache(2);
    const decode = deferred<void>();
    const pending = cache.load("/slow-decode.png");
    images[0]!.decode.mockReturnValue(decode.promise);
    images[0]!.finish();
    const failure = expect(pending).rejects.toThrow("Timed out loading image");

    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    expect(cache.get("/slow-decode.png")).toBeUndefined();
    expect(images[0]!.decode).toHaveBeenCalledOnce();
    expect(images[0]!.src).toBe("");
  });

  it("cancels pending downloads on clear while retaining decoded images", async () => {
    const images: FakeImage[] = [];
    vi.stubGlobal("Image", class extends FakeImage { constructor() { super(); images.push(this); } });
    const cache = new ImageResourceCache(2);
    const ready = cache.load("/ready.png");
    images[0]!.finish();
    await ready;
    const pending = cache.load("/pending.png");
    const pendingResource = cache.get("/pending.png")!;
    const failure = expect(pending).rejects.toThrow("Cancelled loading image");

    cache.clear();
    await failure;
    expect(images[1]!.src).toBe("");
    expect(pendingResource.state).toBe("error");
    images[1]!.finish();
    expect(pendingResource.state).toBe("error");
    expect(cache.get("/pending.png")).toBeUndefined();
    expect(cache.get("/ready.png")?.state).toBe("ready");
    expect(cache.get("/ready.png")?.promise).toBe(ready);
  });

  it("clears old-scope downloads but preserves the current URL shared with SlideViewer", async () => {
    const images: FakeImage[] = [];
    vi.stubGlobal("Image", class extends FakeImage { constructor() { super(); images.push(this); } });
    const cache = new ImageResourceCache(2);
    const oldScope = cache.load("/old-scope.png", "low");
    const current = cache.load("/current-page.png", "high");
    const oldFailure = expect(oldScope).rejects.toThrow("Cancelled loading image");

    cache.clear("/current-page.png");
    await oldFailure;
    expect(images[0]!.src).toBe("");
    expect(cache.get("/old-scope.png")).toBeUndefined();
    expect(cache.get("/current-page.png")?.state).toBe("loading");
    expect(cache.load("/current-page.png", "high")).toBe(current);
    expect(images).toHaveLength(2);

    images[1]!.finish();
    await expect(current).resolves.toBe(images[1]);
    expect(cache.get("/current-page.png")?.state).toBe("ready");
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

  it("releases both prefetch slots after the snapshot and image deadlines", async () => {
    vi.useFakeTimers();
    const images: FakeImage[] = [];
    vi.stubGlobal("Image", class extends FakeImage { constructor() { super(); images.push(this); } });
    const cache = new ImageResourceCache(4);
    const queue = new BoundedPagePrefetchQueue(2);
    const started: string[] = [];
    const work = (key: string) => queue.enqueue(key, async () => {
      started.push(key);
      const snapshot = started.length <= 2
        ? new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("GET deadline")), 10_000))
        : Promise.resolve();
      const image = cache.load(`/${key}.png`).catch(() => undefined);
      await settlePagePrefetch(snapshot, image, () => undefined);
    });

    const first = work("page-1");
    const second = work("page-2");
    const third = work("page-3");
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["page-1", "page-2"]);
    expect(images).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["page-1", "page-2", "page-3"]);
    images[2]!.finish();
    await Promise.all([first, second, third]);
  });
});

class FakeImage extends EventTarget {
  src = "";
  fetchPriority = "auto";
  decode = vi.fn(() => Promise.resolve());

  removeAttribute(name: string) { if (name === "src") this.src = ""; }
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
