import { describe, expect, it } from "vitest";
import { parseQAgentConfig } from "#config";

describe("Source Mode config", () => {
  it("normalizes shorthand source command config", () => {
    const config = parseQAgentConfig(`
project:
  name: shorthand-source
target:
  environment: local
source:
  adapter: generic
  commands:
    test: node
tests:
  layers: [source]
`);

    expect(config.source?.commands?.test).toEqual({ executable: "node" });
  });
});

describe("API/RBAC config", () => {
  it("parses API assertions, profile API headers, and authorization cases", () => {
    const config = parseQAgentConfig(`
project:
  name: api-rbac
target:
  environment: local
  url: http://127.0.0.1:3000
auth:
  profiles:
    admin:
      loginUrl: /login
      credentials:
        username: \${ADMIN_EMAIL}
        password: \${ADMIN_PASSWORD}
      selectors:
        username: "#email"
        password: "#password"
        submit: "button"
      success:
        urlContains: /dashboard
      api:
        headers:
          authorization: Bearer \${ADMIN_TOKEN}
api:
  assertions:
    - key: health
      method: GET
      path: /api/health
      expected_status: 200
  authorization:
    - key: create-course
      permission: create_course
      method: POST
      path: /api/courses
      allow_status: [200, 201]
      deny_status: 403
permissions:
  create_course:
    allow: [admin]
    deny: [learner]
tests:
  layers: [api, authorization]
`);

    expect(config.auth.profiles.admin.api?.headers?.authorization).toBe("Bearer ${ADMIN_TOKEN}");
    expect(config.api.assertions[0].key).toBe("health");
    expect(config.api.authorization[0].permission).toBe("create_course");
  });
});
