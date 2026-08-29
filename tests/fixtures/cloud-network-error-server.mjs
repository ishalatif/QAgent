import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3213);
const host = "127.0.0.1";

const server = createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <title>Network Error Fixture</title>
      <script>fetch("/api/drop").catch(() => {});</script>`);
    return;
  }

  if (request.url === "/api/drop") {
    request.socket.destroy();
    return;
  }

  if (request.url === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  response.writeHead(404);
  response.end("missing");
});

server.listen(port, host, () => {
  console.log(`ready http://${host}:${port}`);
});
