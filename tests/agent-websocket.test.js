import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  ServerWebSocket,
  upgradeWebSocket,
} from "../skills/npc-moneyhand/scripts/lib/websocket.mjs";
import {
  OPCODE,
  clientFrame,
  closeDetails,
  openRawWebSocket,
} from "./helpers/raw-websocket.js";

async function startTransportServer(t, options = {}) {
  const accepted = [];
  const waiters = [];
  const sockets = new Set();
  const server = createServer((_request, response) => {
    response.writeHead(404, { connection: "close", "content-length": "0" });
    response.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const websocket = upgradeWebSocket(request, socket, head, {
      path: "/extension",
      ...options,
    });
    if (!websocket) return;
    const waiter = waiters.shift();
    if (waiter) waiter(websocket);
    else accepted.push(websocket);
  });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const port = server.address().port;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  });
  return {
    port,
    nextAccepted() {
      if (accepted.length) return Promise.resolve(accepted.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

test("RFC6455 upgrade accepts a valid request and exchanges masked text", async (t) => {
  const server = await startTransportServer(t);
  const { client, response } = await openRawWebSocket({ port: server.port });
  t.after(() => client.destroy());

  assert.equal(response.status, 101);
  assert.equal(response.headers.upgrade.toLowerCase(), "websocket");
  assert.equal(response.headers.connection.toLowerCase(), "upgrade");
  assert.equal(response.headers["sec-websocket-accept"], "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");

  const websocket = await server.nextAccepted();
  const received = once(websocket, "message");
  client.sendFrame("masked hello");
  assert.deepEqual(await received, ["masked hello"]);

  websocket.sendText("server reply");
  const reply = await client.nextFrame();
  assert.equal(reply.opcode, OPCODE.TEXT);
  assert.equal(reply.masked, false);
  assert.equal(reply.payload.toString("utf8"), "server reply");
});

test("invalid upgrade requests are rejected before a WebSocket is created", async (t) => {
  const server = await startTransportServer(t);
  const cases = [
    {
      name: "wrong path",
      options: { path: "/wrong" },
      status: 404,
    },
    {
      name: "query-bearing path",
      options: { path: "/extension?peer=other" },
      status: 404,
    },
    {
      name: "normalized dot-segment path",
      options: { path: "/ignored/../extension" },
      status: 404,
    },
    {
      name: "absolute-form target",
      options: { path: `ws://127.0.0.1:${server.port}/extension` },
      status: 404,
    },
    {
      name: "wrong method",
      options: { method: "POST" },
      status: 405,
    },
    {
      name: "HTTP/1.0",
      options: { httpVersion: "1.0" },
      status: 400,
    },
    {
      name: "missing Host",
      options: { headers: { Host: null } },
      status: 400,
    },
    {
      name: "invalid key",
      options: { key: "not-a-websocket-key" },
      status: 400,
    },
    {
      name: "unsupported version",
      options: { headers: { "Sec-WebSocket-Version": "12" } },
      status: 426,
      version: "13",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { client, response } = await openRawWebSocket({
        port: server.port,
        ...entry.options,
      });
      client.destroy();
      assert.equal(response.status, entry.status);
      if (entry.version) assert.equal(response.headers["sec-websocket-version"], entry.version);
    });
  }
});

test("fragmented UTF-8 text survives an interleaved ping control frame", async (t) => {
  const server = await startTransportServer(t);
  const { client, response } = await openRawWebSocket({ port: server.port });
  t.after(() => client.destroy());
  assert.equal(response.status, 101);
  const websocket = await server.nextAccepted();
  const received = once(websocket, "message");

  const frames = Buffer.concat([
    clientFrame(Buffer.from([0x48, 0x69, 0x20, 0xe4]), {
      opcode: OPCODE.TEXT,
      fin: false,
    }),
    clientFrame("probe", { opcode: OPCODE.PING }),
    clientFrame(Buffer.from([0xb8, 0x96, 0xe7, 0x95, 0x8c]), {
      opcode: OPCODE.CONTINUATION,
    }),
  ]);
  client.write(frames);

  const pong = await client.nextFrame();
  assert.equal(pong.opcode, OPCODE.PONG);
  assert.equal(pong.payload.toString("utf8"), "probe");
  assert.deepEqual(await received, ["Hi 世界"]);
});

test("pong control frames respect outbound backpressure and close with 1013", async (t) => {
  class BackpressuredSocket extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.writableLength = 0;
      this.writes = [];
      this.endedWith = undefined;
    }

    setNoDelay() {}

    write(chunk) {
      const bytes = Buffer.from(chunk);
      this.writes.push(bytes);
      this.writableLength += bytes.length;
      return false;
    }

    end(chunk) {
      this.endedWith = chunk ? Buffer.from(chunk) : Buffer.alloc(0);
      return this;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("close");
    }
  }

  const socket = new BackpressuredSocket();
  t.after(() => socket.destroy());
  const websocket = new ServerWebSocket(socket, {
    maxMessageBytes: 1_024,
    maxBufferedBytes: 20,
  });
  const protocolError = once(websocket, "protocolError");
  const pings = Buffer.concat(Array.from(
    { length: 64 },
    () => clientFrame("x", { opcode: OPCODE.PING }),
  ));

  socket.emit("data", pings);

  const [details] = await protocolError;
  assert.deepEqual(details, {
    code: 1013,
    reason: "outbound backpressure",
  });
  assert.equal(socket.writes.length, 2);
  assert.ok(socket.writableLength <= 20);
  assert.ok(socket.endedWith);
  assert.equal(socket.endedWith[0] & 0x0f, OPCODE.CLOSE);
  assert.equal(socket.endedWith.readUInt16BE(2), 1013);
});

test("unmasked, invalid UTF-8 and oversized client messages close with precise codes", async (t) => {
  const cases = [
    {
      name: "unmasked",
      maxMessageBytes: 64,
      frame: () => clientFrame("plain", { masked: false }),
      code: 1002,
    },
    {
      name: "invalid UTF-8",
      maxMessageBytes: 64,
      frame: () => clientFrame(Buffer.from([0xc3, 0x28])),
      code: 1007,
    },
    {
      name: "oversized",
      maxMessageBytes: 16,
      frame: () => clientFrame("x".repeat(17)),
      code: 1009,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const server = await startTransportServer(subtest, {
        maxMessageBytes: entry.maxMessageBytes,
      });
      const { client, response } = await openRawWebSocket({ port: server.port });
      subtest.after(() => client.destroy());
      assert.equal(response.status, 101);
      await server.nextAccepted();
      client.write(entry.frame());
      const close = await client.nextFrame();
      assert.equal(close.opcode, OPCODE.CLOSE);
      assert.equal(closeDetails(close).code, entry.code);
    });
  }
});
