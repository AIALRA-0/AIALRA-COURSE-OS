import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedPg = vi.hoisted(() => ({
  client: {
    connect: vi.fn(),
    query: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  },
  Client: vi.fn()
}));

vi.mock("pg", () => ({ default: { Client: mockedPg.Client } }));

import { acquireProductionApiWriterLock } from "./server.js";

describe("production API writer advisory lock", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPg.Client.mockImplementation(function MockPgClient() { return mockedPg.client; });
    mockedPg.client.connect.mockResolvedValue(undefined);
    mockedPg.client.end.mockResolvedValue(undefined);
  });

  it("preserves local and test modes without opening a PostgreSQL session", async () => {
    const onConnectionLost = vi.fn();

    await expect(acquireProductionApiWriterLock("development", undefined, onConnectionLost)).resolves.toBeUndefined();
    await expect(acquireProductionApiWriterLock("test", "postgres://test", onConnectionLost)).resolves.toBeUndefined();

    expect(mockedPg.Client).not.toHaveBeenCalled();
  });

  it("holds a dedicated session lock until release, then unlocks and closes that session", async () => {
    mockedPg.client.query
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] });

    const lock = await acquireProductionApiWriterLock("production", "postgres://course-os", vi.fn());
    expect(lock).toBeDefined();
    expect(mockedPg.Client).toHaveBeenCalledWith({ connectionString: "postgres://course-os" });
    expect(mockedPg.client.connect).toHaveBeenCalledOnce();
    expect(mockedPg.client.query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked",
      [0x434f5552, 0x434f5301]
    );
    expect(mockedPg.client.end).not.toHaveBeenCalled();

    await lock!.release();
    await lock!.release();

    expect(mockedPg.client.query).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
      [0x434f5552, 0x434f5301]
    );
    expect(mockedPg.client.end).toHaveBeenCalledOnce();
  });

  it("fails production startup clearly when another API session holds the lock", async () => {
    mockedPg.client.query.mockResolvedValueOnce({ rows: [{ locked: false }] });

    await expect(acquireProductionApiWriterLock("production", "postgres://course-os", vi.fn()))
      .rejects.toThrow("API_WRITER_LOCK_HELD: another API process already holds the PostgreSQL writer lock");

    expect(mockedPg.client.connect).toHaveBeenCalledOnce();
    expect(mockedPg.client.end).toHaveBeenCalledOnce();
    expect(mockedPg.client.query).toHaveBeenCalledOnce();
  });

  it("rejects acquisition if the PostgreSQL session ends while the lock query is completing", async () => {
    const endListener = () => {
      const listener = mockedPg.client.on.mock.calls.find(([event]) => event === "end")?.[1] as (() => void) | undefined;
      listener?.();
    };
    mockedPg.client.query.mockImplementationOnce(async () => {
      endListener();
      return { rows: [{ locked: true }] };
    });

    await expect(acquireProductionApiWriterLock("production", "postgres://course-os", vi.fn()))
      .rejects.toThrow("API_WRITER_LOCK_SESSION_LOST_DURING_ACQUISITION");

    expect(mockedPg.client.end).toHaveBeenCalledOnce();
  });

  it("requires DATABASE_URL in production, while bypassing the guard in local mode", async () => {
    await expect(acquireProductionApiWriterLock("production", undefined, vi.fn()))
      .rejects.toThrow("API_WRITER_LOCK_REQUIRES_DATABASE_URL");
    await expect(acquireProductionApiWriterLock("development", undefined, vi.fn())).resolves.toBeUndefined();

    expect(mockedPg.Client).not.toHaveBeenCalled();
  });

  it("reports unexpected loss of the lock session so production can terminate", async () => {
    mockedPg.client.query.mockResolvedValueOnce({ rows: [{ locked: true }] });
    const onConnectionLost = vi.fn();
    const lock = await acquireProductionApiWriterLock("production", "postgres://course-os", onConnectionLost);
    const listener = mockedPg.client.on.mock.calls.find(([event]) => event === "error")?.[1] as ((error: Error) => void) | undefined;
    expect(listener).toBeDefined();

    listener!(new Error("database session dropped"));
    listener!(new Error("duplicate notification"));

    expect(onConnectionLost).toHaveBeenCalledOnce();
    await lock!.release().catch(() => undefined);
  });
});
