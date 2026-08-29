import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3232);
const host = "127.0.0.1";
const failAuth = process.env.QAGENT_AUTH_FAIL === "1";

const loginPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Auth Login</title>
</head>
<body>
  <main>
    <h1>Sign in</h1>
    <form>
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password">
      <button type="button" id="submit">Sign in</button>
    </form>
    <script>
      document.querySelector('#submit').addEventListener('click', () => {
        ${failAuth ? "window.location.href = '/login?error=1';" : "document.cookie = 'qagent_session=ok; path=/'; window.location.href = '/dashboard';"}
      });
    </script>
  </main>
</body>
</html>`;

const dashboardPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Accessible Dashboard</title>
</head>
<body>
  <header><nav aria-label="Primary"><a href="/dashboard">Dashboard</a><a href="/logout">Logout</a></nav></header>
  <main>
    <h1>Dashboard</h1>
    <img alt="Dashboard status is healthy" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='%23007040'/%3E%3C/svg%3E">
    <button type="button">Create report</button>
  </main>
</body>
</html>`;

const server = createServer((request, response) => {
  const cookie = request.headers.cookie ?? "";

  if (request.url?.startsWith("/login")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(loginPage);
    return;
  }

  if (request.url === "/dashboard") {
    if (!cookie.includes("qagent_session=ok")) {
      response.writeHead(302, { location: "/login" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(dashboardPage);
    return;
  }

  if (request.url === "/logout") {
    response.writeHead(302, { location: "/login", "set-cookie": "qagent_session=; Max-Age=0; path=/" });
    response.end();
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(port, host, () => {
  console.log(`ready http://${host}:${port}`);
});
