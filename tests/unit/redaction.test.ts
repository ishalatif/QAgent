import { describe, expect, it } from "vitest";
import { redactObject, redactText } from "#core";

describe("secret redaction", () => {
  it("redacts common bearer tokens and query secrets", () => {
    expect(redactText("Authorization: Bearer abc.def token=secret")).toContain("<redacted>");
  });

  it("redacts nested object values by key", () => {
    const redacted = redactObject({
      headers: { authorization: "Bearer secret", cookie: "sid=123" },
      body: { password: "secret", name: "safe" }
    });

    expect(redacted).toEqual({
      headers: { authorization: "<redacted>", cookie: "<redacted>" },
      body: { password: "<redacted>", name: "safe" }
    });
  });
});
