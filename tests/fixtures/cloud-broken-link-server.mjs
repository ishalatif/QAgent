import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3211);
const host = "127.0.0.1";

const server = createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <title>Broken Link Fixture</title>
      <a href="/missing?tracking=123#section">Missing</a>
      <a href="/ok">OK</a>`);
    return;
  }

  if (request.url === "/ok") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>OK</title>");
    return;
  }

  if (request.url === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  response.writeHead(404, { "content-type": "text/html" });
  response.end("<!doctype html><title>Missing</title>");
});

server.listen(port, host, () => {
  console.log(`ready http://${host}:${port}`);
});
