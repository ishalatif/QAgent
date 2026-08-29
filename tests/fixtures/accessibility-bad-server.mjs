import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3231);
const host = "127.0.0.1";

const badPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Bad Accessibility Fixture</title>
</head>
<body>
  <main>
    <h1>Bad Accessibility Fixture</h1>
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='%23cc0000'/%3E%3C/svg%3E">
    <input id="course-title" name="course-title">
    <button type="button"></button>
  </main>
</body>
</html>`;

const minorPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Non-blocking Accessibility Fixture</title>
</head>
<body>
  <h1>Non-blocking Accessibility Fixture</h1>
  <p>This page intentionally omits landmark regions so axe reports moderate findings.</p>
  <button type="button">Named action</button>
</body>
</html>`;

const server = createServer((request, response) => {
  if (request.url === "/minor") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(minorPage);
    return;
  }

  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(badPage);
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(port, host, () => {
  console.log(`ready http://${host}:${port}`);
});
