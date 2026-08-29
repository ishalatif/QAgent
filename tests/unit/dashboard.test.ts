import { describe, expect, it } from "vitest";
import { DashboardApiError, isPathInside, standardError, standardSuccess } from "#dashboard";

describe("dashboard api response helpers", () => {
  it("wraps successful responses with trace metadata", () => {
    const response = standardSuccess({ ok: true }, "trace-1");

    expect(response).toEqual({
      success: true,
      data: { ok: true },
      meta: { traceId: "trace-1" }
    });
  });

  it("wraps errors using the standard dashboard contract", () => {
    const response = standardError(new DashboardApiError(404, "RUN_NOT_FOUND", "Run not found"), "trace-2");

    expect(response).toEqual({
      success: false,
      error: {
        code: "RUN_NOT_FOUND",
        message: "Run not found",
        details: null
      },
      traceId: "trace-2"
    });
  });
});

describe("dashboard evidence path guard", () => {
  it("allows files under the run artifact directory", () => {
    expect(isPathInside("C:/qagent/runs/run-1", "C:/qagent/runs/run-1/evidence/a.json")).toBe(true);
  });

  it("blocks path traversal outside the run artifact directory", () => {
    expect(isPathInside("C:/qagent/runs/run-1", "C:/qagent/runs/run-1/../run-2/evidence/a.json")).toBe(false);
  });
});
