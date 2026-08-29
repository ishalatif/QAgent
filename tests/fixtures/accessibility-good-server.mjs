import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3230);
const host = "127.0.0.1";

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Accessible Fixture</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111; background: #fff; }
    a, button { font: inherit; }
  </style>
</head>
<body>
  <header>
    <nav aria-label="Primary">
      <a href="/">Home</a>
    </nav>
  </header>
  <main>
    <h1>Accessible Fixture</h1>
    <img alt="A simple green square" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='%23007040'/%3E%3C/svg%3E">
    <form>
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email">
      <button type="button">Save settings</button>
    </form>
  </main>
</body>
</html>`;

const server = createServer((request, response) => {
  if (request.url === "/" || request.url === "/login") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(port, host, () => {
  console.log(`ready http://${host}:${port}`);
});
