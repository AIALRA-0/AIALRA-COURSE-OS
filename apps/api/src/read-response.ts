import type { Response } from "express";

/** A deadline or disconnected reader owns the final response. Late route work
 * must not enter Express's serializers, header setters, or socket writers. */
export function protectReadResponse(response: Response, onLateResponse: (method: string) => void): void {
  let reported = false;
  const closed = (method: string) => {
    if (!response.writableEnded && !response.destroyed) return false;
    if (!reported) { reported = true; onLateResponse(method); }
    return true;
  };
  const chainMethods = ["json", "send", "status", "setHeader", "removeHeader", "end"] as const;
  for (const method of chainMethods) {
    const original = response[method];
    Object.defineProperty(response, method, {
      configurable: true,
      value: function (this: Response, ...args: unknown[]) {
        if (closed(method)) return this;
        return Reflect.apply(original, this, args);
      }
    });
  }
  const write = response.write;
  response.write = function (this: Response, ...args: Parameters<typeof write>) {
    if (closed("write")) return false;
    return Reflect.apply(write, this, args);
  } as typeof write;
}
