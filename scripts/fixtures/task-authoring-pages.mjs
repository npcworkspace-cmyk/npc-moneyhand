import { createServer } from "node:http";
import { createInterface } from "node:readline";

const pages = new Map([
  ["/alpha", {
    id: "alpha",
    title: "MoneyHand Alpha",
    cards: ["Amber signal", "Agent-ready output"],
  }],
  ["/beta", {
    id: "beta",
    title: "MoneyHand Beta",
    cards: ["Bounded batch", "Browser-owned evidence", "Checkpoint saved"],
  }],
  ["/gamma", {
    id: "literal-${POST_ID}",
    title: "MoneyHand Gamma",
    cards: ["Literal interpolation sentinel"],
  }],
]);

const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  requests.push({ method: request.method, path: url.pathname });
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (url.pathname === "/requests") {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(`${JSON.stringify(requests)}\n`);
    return;
  }
  const page = pages.get(url.pathname);
  if (!page) {
    response.writeHead(404, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("not found");
    return;
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "content-type": "text/html; charset=utf-8",
  });
  response.end([
    "<!doctype html>",
    '<meta charset="utf-8">',
    `<title>${page.title}</title>`,
    "<style>body{font:18px system-ui;margin:48px}article{margin:12px;padding:12px;border:1px solid #222}</style>",
    `<main data-page-id="${page.id}">`,
    `<h1>${page.title}</h1>`,
    ...page.cards.map((card, index) => (
      `<article class="record-card" data-index="${index + 1}">${card}</article>`
    )),
    "</main>",
  ].join(""));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({
    event: "fixture.ready",
    origin: `http://127.0.0.1:${address.port}`,
    pages: [...pages.keys()],
  })}\n`);
});

async function stop() {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  process.stdout.write(`${JSON.stringify({ event: "fixture.closed", requests })}\n`);
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (line.trim().toLowerCase() === "stop") stop().catch(() => process.exitCode = 1);
});

process.on("SIGINT", () => stop().finally(() => process.exit()));
process.on("SIGTERM", () => stop().finally(() => process.exit()));
