export type ImagePriority = "high" | "low";
export type ImageResourceState = "loading" | "ready" | "error";

export interface ImageResource {
  url: string;
  image: HTMLImageElement;
  state: ImageResourceState;
  priority: ImagePriority;
  promise: Promise<HTMLImageElement>;
  error?: unknown;
  cancel?: () => void;
}

const IMAGE_LOAD_TIMEOUT_MS = 10_000;

/** Keeps only a small set of decoded images and shares concurrent requests by URL. */
export class ImageResourceCache {
  private readonly resources = new Map<string, ImageResource>();
  private readonly settledLimit: number;
  private readonly resourceLimit: number;

  constructor(limit = 8) {
    this.settledLimit = Math.max(1, limit);
    this.resourceLimit = this.settledLimit + 2;
  }

  get size(): number { return this.resources.size; }

  get(url: string): ImageResource | undefined {
    const resource = this.resources.get(url);
    if (resource) this.touch(url, resource);
    return resource;
  }

  load(url: string, priority: ImagePriority = "low"): Promise<HTMLImageElement> {
    const existing = this.resources.get(url);
    if (existing?.state === "ready" || existing?.state === "loading") {
      if (existing.state === "loading" && priority === "high") {
        existing.priority = "high";
        if ("fetchPriority" in existing.image) existing.image.fetchPriority = "high";
      }
      this.touch(url, existing);
      return existing.promise;
    }
    if (existing?.state === "error") this.resources.delete(url);
    if (!this.makeRoom()) return Promise.reject(new Error("Image prefetch deferred because all image slots are still loading"));

    const image = new Image();
    if ("fetchPriority" in image) image.fetchPriority = priority;
    const resource: ImageResource = { url, image, state: "loading", priority, promise: Promise.resolve(image) };
    const load = this.loadAndDecode(image, url);
    resource.cancel = load.cancel;
    resource.promise = load.promise.then(() => {
      resource.state = "ready";
      resource.cancel = undefined;
      if (this.resources.get(url) === resource) {
        this.touch(url, resource);
        this.trimSettled();
      }
      return image;
    }).catch((error: unknown) => {
      resource.state = "error";
      resource.error = error;
      resource.cancel = undefined;
      if (this.resources.get(url) === resource) this.resources.delete(url);
      throw error;
    });
    // A request can be superseded before its consumer reaches the rejection handler.
    // Attach a sink while preserving the original rejecting promise for callers.
    void resource.promise.catch(() => undefined);
    this.resources.set(url, resource);
    return resource.promise;
  }

  retry(url: string, priority: ImagePriority = "high"): Promise<HTMLImageElement> {
    const existing = this.resources.get(url);
    if (existing?.state === "loading") return existing.promise;
    if (existing && this.resources.get(url) === existing) this.resources.delete(url);
    return this.load(url, priority);
  }

  clear(preserveUrl?: string): void {
    for (const [url, resource] of this.resources) {
      if (url === preserveUrl) continue;
      if (resource.state !== "loading") continue;
      resource.cancel?.();
      if (this.resources.get(url) === resource) this.resources.delete(url);
    }
  }

  private loadAndDecode(image: HTMLImageElement, url: string): { promise: Promise<void>; cancel: () => void } {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resolveLoad!: () => void;
    let rejectLoad!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });

    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
    };
    const settle = (error?: unknown, abortSource = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (abortSource) image.removeAttribute("src");
      if (error !== undefined) rejectLoad(error);
      else resolveLoad();
    };
    const onLoad = () => {
      if (typeof image.decode !== "function") {
        settle();
        return;
      }
      try {
        void image.decode().then(() => settle(), (error: unknown) => settle(error));
      } catch (error) {
        settle(error);
      }
    };
    const onError = () => settle(new Error(`Unable to load image: ${url}`));

    image.addEventListener("load", onLoad);
    image.addEventListener("error", onError);
    timeout = setTimeout(() => settle(new Error(`Timed out loading image: ${url}`), true), IMAGE_LOAD_TIMEOUT_MS);
    image.src = url;

    return {
      promise,
      cancel: () => settle(new Error(`Cancelled loading image: ${url}`), true)
    };
  }

  private touch(url: string, resource: ImageResource): void {
    this.resources.delete(url);
    this.resources.set(url, resource);
  }

  private makeRoom(): boolean {
    while (this.resources.size >= this.resourceLimit) {
      const settled = [...this.resources.entries()].find(([, resource]) => resource.state !== "loading");
      if (!settled) return false;
      this.resources.delete(settled[0]);
    }
    return true;
  }

  private trimSettled(): void {
    let settledCount = [...this.resources.values()].filter((resource) => resource.state !== "loading").length;
    for (const [url, resource] of this.resources) {
      if (settledCount <= this.settledLimit) return;
      if (resource.state === "loading") continue;
      this.resources.delete(url);
      settledCount -= 1;
    }
  }
}

/** Stores a page as soon as its snapshot is ready while its image continues loading. */
export async function settlePagePrefetch<T>(snapshot: Promise<T>, image: Promise<unknown>, onSnapshot: (value: T) => void): Promise<void> {
  const snapshotReady = snapshot.then(onSnapshot);
  await Promise.allSettled([snapshotReady, image]);
}

interface QueueEntry {
  key: string;
  priority: number;
  order: number;
  work: () => Promise<void> | void;
  resolve: () => void;
  reject: (error: unknown) => void;
  promise: Promise<void>;
}

/** Deduplicates page prefetches and caps background page work at a fixed concurrency. */
export class BoundedPagePrefetchQueue {
  private readonly queued = new Map<string, QueueEntry>();
  private readonly active = new Map<string, Promise<void>>();
  private order = 0;

  constructor(private readonly concurrency = 2, private readonly maxQueued = 4) {}

  enqueue(key: string, work: () => Promise<void> | void, priority = 0): Promise<void> {
    const running = this.active.get(key);
    if (running) return running;
    const queued = this.queued.get(key);
    if (queued) {
      queued.priority = Math.max(queued.priority, priority);
      queued.work = work;
      return queued.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
    const entry = { key, priority, order: this.order++, work, resolve, reject, promise };
    this.queued.set(key, entry);
    while (this.queued.size > this.maxQueued) {
      const lowest = [...this.queued.values()].sort((a, b) => a.priority - b.priority || b.order - a.order)[0]!;
      this.queued.delete(lowest.key);
      lowest.resolve();
    }
    this.drain();
    return promise;
  }

  clearPending(): void {
    for (const entry of this.queued.values()) entry.resolve();
    this.queued.clear();
  }

  private drain(): void {
    while (this.active.size < this.concurrency && this.queued.size > 0) {
      const entry = [...this.queued.values()].sort((a, b) => b.priority - a.priority || a.order - b.order)[0]!;
      this.queued.delete(entry.key);
      const execution = Promise.resolve().then(entry.work);
      this.active.set(entry.key, entry.promise);
      void execution.then(entry.resolve, entry.reject).finally(() => {
        this.active.delete(entry.key);
        this.drain();
      });
    }
  }
}
