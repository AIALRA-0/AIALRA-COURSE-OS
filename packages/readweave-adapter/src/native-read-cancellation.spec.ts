import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { EtapiReadWeaveCourseApi, withReadBudget } from "./index.js";

it("closes a native HTTP read on budget expiry and allows the next request to succeed", async () => {
  let requestCount = 0;
  let announceResponseClosed!: () => void;
  const responseClosed = new Promise<void>((resolve) => { announceResponseClosed = resolve; });
  const server = createServer((request, response) => {
    requestCount += 1;
    if (request.url !== "/etapi/notes/root") {
      response.writeHead(404).end();
      return;
    }
    if (requestCount === 1) {
      response.once("close", () => {
        if (!response.writableEnded) announceResponseClosed();
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"noteId":"root",');
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ noteId: "root", title: "root", type: "text", mime: "text/html" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("native test server did not bind a TCP port");
  const api = new EtapiReadWeaveCourseApi({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "test-token",
    parentNoteId: "root",
    requestTimeoutMs: 1_000
  });

  try {
    await expect(withReadBudget({ timeoutMs: 100 }, () => api.verifyConnection())).rejects.toThrow("READ_DEADLINE_EXCEEDED");
    let closeTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        responseClosed,
        new Promise<never>((_resolve, reject) => { closeTimeout = setTimeout(() => reject(new Error("native response socket was not closed")), 2_000); })
      ]);
    } finally {
      if (closeTimeout !== undefined) clearTimeout(closeTimeout);
    }
    await expect(api.verifyConnection()).resolves.toBeUndefined();
    expect(requestCount).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 5_000);
