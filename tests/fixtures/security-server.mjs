import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3234);
const host = "127.0.0.1";

const secureHeaders = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "set-cookie": "qagent_secure=1; Path=/; HttpOnly; SameSite=Lax"
};

const server = createServer((request, response) => {
  if (request.url === "/" || request.url === "/secure") {
    response.writeHead(200, secureHeaders);
    response.end("<!doctype html><title>Secure Fixture</title><main>secure</main>");
    return;
  }

  if (request.url === "/weak") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "qagent_weak=1; Path=/"
    });
    response.end("<!doctype html><title>Weak Fixture</title><main>weak</main>");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(port, host, () => {
  console.log(`ready http://${host}:${port}`);
});
