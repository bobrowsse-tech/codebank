import { parentPort, workerData } from "node:worker_threads";
import { mine } from "../../core/src/mining/scan.ts";

const data = workerData as { home: string; roots: string[]; ignore?: string[] };
const controller = new AbortController();
parentPort?.on("message", (message: { type?: string }) => {
  if (message?.type === "cancel") controller.abort();
});

mine(data.home, {
  roots: data.roots,
  ignore: data.ignore,
  signal: controller.signal,
  onProgress: (progress) => parentPort?.postMessage({ type: "progress", progress }),
})
  .then((result) => parentPort?.postMessage({ type: "done", result }))
  .catch((error: unknown) => parentPort?.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) }));
