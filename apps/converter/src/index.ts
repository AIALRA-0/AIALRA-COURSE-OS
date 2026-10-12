import { resolve } from "node:path";
import { FileConversionQueueWorker } from "@course-os/converter";

const dataDir = resolve(process.env.COURSE_OS_DATA_DIR || "/data");
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

const queueRoot = resolve(dataDir, "conversion-queue");
const workers = [
  new FileConversionQueueWorker({ queueRoot, purpose: "inspect" }),
  new FileConversionQueueWorker({ queueRoot, purpose: "convert" })
];
process.stdout.write("Course OS offline converter ready\n");
try {
  const outcomes = await Promise.allSettled(workers.map(async (worker) => {
    try { await worker.serve(controller.signal); }
    catch (error) {
      controller.abort();
      throw error;
    }
  }));
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
} finally {
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
}
