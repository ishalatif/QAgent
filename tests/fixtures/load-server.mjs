import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3235);
const host = "127.0.0.1";

const server = createServer((request, response) => {
  if (request.url === "/" || request.url === "/ok") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }

  if (request.url === "/error") {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("error");
    return;
  }

  if (request.url === "/slow") {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("slow");
    }, 120);
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(port, host, () => {
  console.log(`ready http://${host}:${port}`);
});
