import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3233);
const host = "127.0.0.1";

const fastPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Fast Performance Fixture</title>
</head>
<body>
  <main>
    <h1>Fast Performance Fixture</h1>
    <p>Small deterministic page.</p>
  </main>
</body>
</html>`;

const slowPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Slow Performance Fixture</title>
</head>
<body>
  <main>
    <h1>Slow Performance Fixture</h1>
    <p>This response intentionally waits before first byte.</p>
  </main>
</body>
</html>`;

const server = createServer((request, response) => {
  if (request.url === "/" || request.url === "/fast") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fastPage);
    return;
  }

  if (request.url === "/slow") {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(slowPage);
    }, 180);
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(port, host, () => {
  console.log(`ready http://${host}:${port}`);
});
