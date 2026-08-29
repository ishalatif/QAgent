import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3215);
const host = "127.0.0.1";
const validUsername = "admin@test.local";
const validPassword = "Password123!";
const sessionCookie = "qagent_session=valid";

const server = createServer((request, response) => {
  if (request.url === "/" && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <title>Auth Fixture Home</title>
      <a href="/login">Login</a>
      <a href="/dashboard">Dashboard</a>
      <script>fetch("/api/session").catch(() => {});</script>`);
    return;
  }

  if (request.url === "/api/session") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ authenticated: hasSession(request) }));
    return;
  }

  if (request.url === "/login" && request.method === "GET") {
    writeLogin(response);
    return;
  }

  if (request.url === "/login" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const params = new URLSearchParams(body);
      if (params.get("email") === validUsername && params.get("password") === validPassword) {
        response.writeHead(302, {
          location: "/dashboard",
          "set-cookie": `${sessionCookie}; HttpOnly; SameSite=Lax; Path=/`
        });
        response.end();
        return;
      }

      writeLogin(response, 401, true);
    });
    return;
  }

  if (request.url === "/dashboard" && request.method === "GET") {
    if (!hasSession(request)) {
      response.writeHead(302, { location: "/login" });
      response.end();
      return;
    }

    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html>
      <title>Dashboard</title>
      <h1>Dashboard</h1>
      <p class="dashboard-marker">Signed in</p>
      <a href="/logout">Logout</a>`);
    return;
  }

  if (request.url === "/logout" && request.method === "GET") {
    response.writeHead(302, {
      location: "/login",
      "set-cookie": "qagent_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    });
    response.end();
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

function writeLogin(response, status = 200, showError = false) {
  response.writeHead(status, { "content-type": "text/html" });
  response.end(`<!doctype html>
    <title>Login</title>
    <form method="post" action="/login">
      <input name="email" type="email" autocomplete="username">
      <input name="password" type="password" autocomplete="current-password">
      <button type="submit">Sign in</button>
      ${showError ? '<p class="login-error">Invalid credentials</p>' : ""}
    </form>`);
}

function hasSession(request) {
  return String(request.headers.cookie ?? "").split(";").map((item) => item.trim()).includes(sessionCookie);
}
