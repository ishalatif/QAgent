import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Page } from "playwright";
import type { EvidenceRef } from "#contracts";
import { sha256, stableRecordId } from "./ids.js";
import { normalizePageUrl } from "./url-utils.js";

export function writeDiscoveryArtifact(artifactDir: string, runId: string, payload: unknown): EvidenceRef {
  const relativePath = "discovery.json";
  const fullPath = join(artifactDir, relativePath);
  const content = `${JSON.stringify(payload, jsonReplacer, 2)}\n`;
  writeFileSync(fullPath, content, "utf8");
  return evidenceRefFromFile({ artifactDir, runId, type: "json", relativePath });
}

export async function captureFailureScreenshot(input: {
  page: Page;
  artifactDir: string;
  runId: string;
  url: string;
  label: string;
}): Promise<EvidenceRef | undefined> {
  const relativePath = join("screenshots", `${safeFilePart(input.label)}-${safeFilePart(input.url)}.png`);
  const fullPath = join(input.artifactDir, relativePath);
  mkdirSync(join(input.artifactDir, "screenshots"), { recursive: true });

  try {
    await input.page.evaluate(() => (globalThis as unknown as { stop?: () => void }).stop?.()).catch(() => undefined);
    await input.page.screenshot({ path: fullPath, fullPage: true, timeout: 2000 });
  } catch {
    try {
      await input.page.goto("about:blank", { timeout: 1000 }).catch(() => undefined);
      await input.page.screenshot({ path: fullPath, fullPage: true, timeout: 2000 });
    } catch {
      return undefined;
    }
  }

  return evidenceRefFromFile({ artifactDir: input.artifactDir, runId: input.runId, type: "screenshot", relativePath });
}

export function evidenceRefFromFile(input: {
  artifactDir: string;
  runId: string;
  type: EvidenceRef["type"];
  relativePath: string;
}): EvidenceRef {
  const fullPath = join(input.artifactDir, input.relativePath);
  const content = readFileSync(fullPath);
  const stat = statSync(fullPath);
  return {
    id: stableRecordId(input.runId, "evidence", input.relativePath),
    type: input.type,
    relativePath: input.relativePath,
    sha256: sha256(content),
    size: stat.size
  };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) {
    return [...value];
  }
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return value;
}

function safeFilePart(input: string): string {
  let value = input;
  try {
    value = normalizePageUrl(input);
  } catch {
    value = basename(input);
  }

  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "page";
}
