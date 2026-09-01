import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the production worker");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const apiBaseUrl = (process.env.COURSE_OS_API_URL || "http://api:4100").replace(/\/$/, "");
const schemaPath = fileURLToPath(new URL("../../../infra/postgres/operational-schema.postgres", import.meta.url));

async function loadSecret(filePath: string | undefined): Promise<string> {
  if (!filePath) return "";
  try { return (await readFile(filePath, "utf8")).trim(); }
  catch { return ""; }
}

const workerToken = process.env.COURSE_OS_WORKER_TOKEN?.trim() || await loadSecret(process.env.COURSE_OS_WORKER_TOKEN_FILE);
if (process.env.COURSE_OS_EXTERNAL_WORKER !== "true") {
  process.stdout.write("Course OS worker is idle because external execution is disabled\n");
  let idleStopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { idleStopping = true; });
  while (!idleStopping) await new Promise((resolveWait) => setTimeout(resolveWait, 30_000));
  await pool.end();
  process.exit(0);
}
if (!workerToken) throw new Error("COURSE_OS_WORKER_TOKEN is required when external execution is enabled");

await pool.query(await readFile(schemaPath, "utf8"));
process.stdout.write("Course OS worker is ready\n");

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopping = true; });

while (!stopping) {
  try {
    const queued = await pool.query<{ id: string }>(`
      SELECT job->>'id' AS id
      FROM operational_state, jsonb_array_elements(state->'jobs') AS job
      WHERE job->>'state' = 'queued'
        AND COALESCE((job->>'cancelRequested')::boolean, false) = false
      ORDER BY job->>'createdAt'
      LIMIT 8
    `);
    await Promise.all(queued.rows.map((job) => dispatch(job.id)));
  } catch (error) {
    process.stderr.write(`worker poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
}

await pool.end();

async function dispatch(jobId: string): Promise<void> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/internal/worker/jobs/${encodeURIComponent(jobId)}/run`, {
      method: "POST",
      headers: { "X-Course-Worker-Token": workerToken }
    });
    if (!response.ok && response.status !== 404) process.stderr.write(`worker dispatch failed for ${jobId}: HTTP ${response.status}\n`);
  } catch (error) {
    process.stderr.write(`worker dispatch failed for ${jobId}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
