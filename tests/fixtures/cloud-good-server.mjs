import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3210);
const host = "127.0.0.1";

const server = createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <title>Smoke Home</title>
      <a href="/about">About</a>
      <a href="https://example.com/external">External</a>
      <button type="button">Safe inventory button</button>
      <script>fetch("/api/data").catch(() => {});</script>`);
    return;
  }

  if (request.url === "/about") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>About</title>");
    return;
  }

  if (request.url === "/api/data") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.url === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("missing");
});

server.listen(port, host, () => {
  console.log(`ready http://${host}:${port}`);
});
