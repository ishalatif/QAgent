import type { BrowserTestMetadata, BrowserTestPriority, EvidenceRef, ResultStatus } from "#contracts";

export interface BrowserTestContext {
  baseUrl: string;
  runId: string;
  profile?: string;
}

export interface BrowserTestOutcome {
  status: Extract<ResultStatus, "PASS" | "FAIL" | "BLOCKED" | "SKIPPED">;
  expected: unknown;
  actual: unknown;
  reason?: string;
  evidenceRefs?: EvidenceRef[];
}

export interface BrowserTestDefinition<TContext extends BrowserTestContext = BrowserTestContext> extends BrowserTestMetadata {
  run(ctx: TContext): Promise<BrowserTestOutcome>;
}

export interface BrowserTestFilter {
  keys?: string[];
  tags?: string[];
  profile?: string;
}

export class DuplicateBrowserTestKeyError extends Error {
  constructor(key: string) {
    super(`Duplicate browser test key: ${key}`);
    this.name = "DuplicateBrowserTestKeyError";
  }
}

export class BrowserTestRegistry<TContext extends BrowserTestContext = BrowserTestContext> {
  private readonly tests = new Map<string, BrowserTestDefinition<TContext>>();

  register(test: BrowserTestDefinition<TContext>): void {
    validateMetadata(test);
    if (this.tests.has(test.key)) {
      throw new DuplicateBrowserTestKeyError(test.key);
    }
    this.tests.set(test.key, {
      ...test,
      tags: [...test.tags].sort(),
      dependencies: [...test.dependencies]
    });
  }

  all(): BrowserTestDefinition<TContext>[] {
    return [...this.tests.values()].sort(compareTests);
  }

  metadata(filter: BrowserTestFilter = {}): BrowserTestMetadata[] {
    return this.filter(filter).map(({ run: _run, ...metadata }) => metadata);
  }

  get(key: string): BrowserTestDefinition<TContext> | undefined {
    return this.tests.get(key);
  }

  filter(filter: BrowserTestFilter = {}): BrowserTestDefinition<TContext>[] {
    const keys = new Set(filter.keys ?? []);
    const tags = new Set(filter.tags ?? []);

    return this.all().filter((test) => {
      if (keys.size > 0 && !keys.has(test.key)) {
        return false;
      }
      if (tags.size > 0 && !test.tags.some((tag) => tags.has(tag))) {
        return false;
      }
      if (filter.profile && test.profile !== filter.profile) {
        return false;
      }
      return true;
    });
  }

  resolveExecutionOrder(filter: BrowserTestFilter = {}): BrowserTestDefinition<TContext>[] {
    const selected = new Map(this.filter(filter).map((test) => [test.key, test]));
    for (const test of [...selected.values()]) {
      for (const dependency of test.dependencies) {
        const dependencyTest = this.tests.get(dependency);
        if (dependencyTest) {
          selected.set(dependencyTest.key, dependencyTest);
        }
      }
    }

    const resolved: BrowserTestDefinition<TContext>[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (test: BrowserTestDefinition<TContext>) => {
      if (visited.has(test.key)) {
        return;
      }
      if (visiting.has(test.key)) {
        throw new Error(`Circular browser test dependency detected at ${test.key}`);
      }
      visiting.add(test.key);
      for (const dependency of [...test.dependencies].sort()) {
        const dependencyTest = selected.get(dependency);
        if (dependencyTest) {
          visit(dependencyTest);
        }
      }
      visiting.delete(test.key);
      visited.add(test.key);
      resolved.push(test);
    };

    for (const test of [...selected.values()].sort(compareTests)) {
      visit(test);
    }

    return resolved;
  }
}

function compareTests(a: BrowserTestMetadata, b: BrowserTestMetadata): number {
  return priorityRank(a.priority) - priorityRank(b.priority) || a.key.localeCompare(b.key);
}

function priorityRank(priority: BrowserTestPriority): number {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[priority];
}

function validateMetadata(test: BrowserTestMetadata): void {
  if (!test.key.trim()) {
    throw new Error("Browser test key is required.");
  }
  if (!test.title.trim()) {
    throw new Error(`Browser test '${test.key}' title is required.`);
  }
}
