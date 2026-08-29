import { createHash } from "node:crypto";

export function stableRecordId(runId: string, type: string, input: string): string {
  const digest = createHash("sha256").update(`${type}:${input}`).digest("hex").slice(0, 16);
  return `${runId}:${type}:${digest}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function elapsedMs(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
