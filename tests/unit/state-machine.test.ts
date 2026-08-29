import { describe, expect, it } from "vitest";
import { assertValidRunTransition, InvalidRunTransitionError } from "#core";

describe("run state machine", () => {
  it("allows monotonic normal transitions", () => {
    expect(() => assertValidRunTransition("CREATED", "VALIDATING")).not.toThrow();
    expect(() => assertValidRunTransition("VALIDATING", "RUNNING")).not.toThrow();
    expect(() => assertValidRunTransition("RUNNING", "COMPLETED")).not.toThrow();
  });

  it("rejects transitions out of terminal statuses", () => {
    expect(() => assertValidRunTransition("FAILED", "RUNNING")).toThrow(InvalidRunTransitionError);
    expect(() => assertValidRunTransition("COMPLETED", "RUNNING")).toThrow(InvalidRunTransitionError);
  });
});
