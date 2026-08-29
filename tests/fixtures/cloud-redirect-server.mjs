import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3214);
const host = "127.0.0.1";

const server = createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(302, { location: "/final" });
    response.end();
    return;
  }

  if (request.url === "/final") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Redirect Final</title><a href='/about'>About</a>");
    return;
  }

  if (request.url === "/about") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>About</title>");
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
