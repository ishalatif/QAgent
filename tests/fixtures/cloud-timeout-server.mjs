import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3215);
const host = "127.0.0.1";

const server = createServer((request, response) => {
  if (request.url === "/") {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Too Late</title>");
    }, 10000);
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
