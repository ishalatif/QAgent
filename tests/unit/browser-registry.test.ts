import { describe, expect, it } from "vitest";
import { BrowserTestRegistry, DuplicateBrowserTestKeyError, type BrowserTestDefinition } from "#browser-tests";

describe("BrowserTestRegistry", () => {
  it("rejects duplicate keys", () => {
    const registry = new BrowserTestRegistry();
    registry.register(testDefinition({ key: "auth.valid-login" }));

    expect(() => registry.register(testDefinition({ key: "auth.valid-login" }))).toThrow(DuplicateBrowserTestKeyError);
  });

  it("orders tests deterministically by priority and key", () => {
    const registry = new BrowserTestRegistry();
    registry.register(testDefinition({ key: "navigation.dashboard", priority: "P1" }));
    registry.register(testDefinition({ key: "auth.valid-login", priority: "P0" }));
    registry.register(testDefinition({ key: "auth.invalid-login", priority: "P0" }));

    expect(registry.all().map((test) => test.key)).toEqual(["auth.invalid-login", "auth.valid-login", "navigation.dashboard"]);
  });

  it("filters by key, tag, and profile", () => {
    const registry = new BrowserTestRegistry();
    registry.register(testDefinition({ key: "auth.valid-login", tags: ["auth"], profile: "admin" }));
    registry.register(testDefinition({ key: "navigation.dashboard", tags: ["navigation"], profile: "admin" }));
    registry.register(testDefinition({ key: "public.home", tags: ["navigation"] }));

    expect(registry.filter({ keys: ["auth.valid-login"] }).map((test) => test.key)).toEqual(["auth.valid-login"]);
    expect(registry.filter({ tags: ["navigation"] }).map((test) => test.key)).toEqual(["navigation.dashboard", "public.home"]);
    expect(registry.filter({ profile: "admin" }).map((test) => test.key)).toEqual(["auth.valid-login", "navigation.dashboard"]);
  });

  it("includes dependencies before selected dependent tests", () => {
    const registry = new BrowserTestRegistry();
    registry.register(testDefinition({ key: "navigation.dashboard", priority: "P1", dependencies: ["auth.valid-login"] }));
    registry.register(testDefinition({ key: "auth.valid-login", priority: "P0" }));

    expect(registry.resolveExecutionOrder({ keys: ["navigation.dashboard"] }).map((test) => test.key)).toEqual(["auth.valid-login", "navigation.dashboard"]);
  });
});

function testDefinition(input: Partial<BrowserTestDefinition> & { key: string }): BrowserTestDefinition {
  return {
    title: input.key,
    layer: "browser",
    tags: input.tags ?? [],
    priority: input.priority ?? "P1",
    profile: input.profile,
    timeoutMs: input.timeoutMs ?? 1_000,
    dependencies: input.dependencies ?? [],
    async run() {
      return {
        status: "PASS",
        expected: "pass",
        actual: "pass"
      };
    },
    ...input
  };
}
