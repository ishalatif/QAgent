import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3225);
const host = "127.0.0.1";

const server = createServer((request, response) => {
  const role = String(request.headers["x-qagent-role"] ?? "anonymous");

  if (request.url === "/api/health" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.url === "/api/courses" && request.method === "GET") {
    response.writeHead(role === "anonymous" ? 401 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({ role, courses: [] }));
    return;
  }

  if (request.url === "/api/courses" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      if (role === "admin") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ created: true, role, body: JSON.parse(body || "{}") }));
        return;
      }

      if (role === "learner") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ created: true, role, defect: "intentional-rbac-bypass" }));
        return;
      }

      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "forbidden", role }));
    });
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, host, () => {
  console.log(`ready http://${host}:${port}`);
});
