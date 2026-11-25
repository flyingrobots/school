// `school check <folder>` (flyingrobots/school#197): loads a course folder with School's own loader.
// Stub: every message type is published (server/schemas/check/); the checks are not written yet.
import { join } from "node:path";
import { jsonLines, loadSchemas } from "./jsonl.ts";

const KIND = "school.check";
const schemas = loadSchemas(join(import.meta.dir, "schemas", "check"));
const out = jsonLines({ kind: KIND, schemas });
out.emit("stderr", `${KIND}.error.failed`, { event: "error", error: "failed", code: 1, message: "not implemented" });
process.exit(1);
