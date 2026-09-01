import { resolve } from "node:path";
import { FileConversionQueueWorker } from "@course-os/converter";

const dataDir = resolve(process.env.COURSE_OS_DATA_DIR || "/data");
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());

const worker = new FileConversionQueueWorker({ queueRoot: resolve(dataDir, "conversion-queue") });
process.stdout.write("Course OS offline converter ready\n");
await worker.serve(controller.signal);
