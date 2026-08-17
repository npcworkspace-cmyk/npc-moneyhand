import { createConnection } from "node:net";

export const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xA,
});

const DEFAULT_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const DEFAULT_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const DEFAULT_MASK = Buffer.from([0x12, 0x34, 0x56, 0x78]);

function payloadBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value ?? ""), "utf8");
}

export function clientFrame(payload, options = {}) {
  const body = payloadBuffer(payload);
  const fin = options.fin !== false;
  const opcode = options.opcode ?? OPCODE.TEXT;
  const masked = options.masked !== false;
  const mask = options.maskKey ? Buffer.from(options.maskKey) : DEFAULT_MASK;
  if (masked && mask.length !== 4) throw new Error("maskKey must contain four bytes");

  let header;
  if (body.length < 126) {
    header = Buffer.from([
      (fin ? 0x80 : 0) | opcode,
      (masked ? 0x80 : 0) | body.length,
    ]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = (masked ? 0x80 : 0) | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = (masked ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }

  if (!masked) return Buffer.concat([header, body]);
  const encoded = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) {
    encoded[index] = body[index] ^ mask[index & 3];
  }
  return Buffer.concat([header, mask, encoded]);
}

export function closeFrame(code = 1000, reason = "") {
  const reasonBytes = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return clientFrame(payload, { opcode: OPCODE.CLOSE });
}

export function closeDetails(frame) {
  if (frame.opcode !== OPCODE.CLOSE) throw new Error("frame is not a close frame");
  if (frame.payload.length < 2) return { code: 1005, reason: "" };
  return {
    code: frame.payload.readUInt16BE(0),
    reason: frame.payload.subarray(2).toString("utf8"),
  };
}

function decodeOne(buffer) {
  if (buffer.length < 2) return undefined;
  const first = buffer[0];
  const second = buffer[1];
  const fin = Boolean(first & 0x80);
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    const large = buffer.readBigUInt64BE(2);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("server frame is too large");
    length = Number(large);
    offset = 10;
  }
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + length) return undefined;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  const payloadOffset = offset + maskBytes;
  const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index & 3];
    }
  }
  return {
    consumed: payloadOffset + length,
    frame: {
      fin,
      opcode,
      masked,
      payload,
    },
  };
}

export class RawWebSocketClient {
  constructor(socket, initialData = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = Buffer.from(initialData);
    this.frames = [];
    this.waiters = [];
    this.closed = socket.destroyed;
    this.closeError = undefined;
    socket.on("data", (chunk) => {
      this.buffer = this.buffer.length
        ? Buffer.concat([this.buffer, chunk])
        : Buffer.from(chunk);
      this.#drainFrames();
    });
    socket.on("error", (error) => {
      this.closeError = error;
    });
    socket.on("close", () => {
      this.closed = true;
      this.#rejectWaiters(this.closeError || new Error("socket closed before next frame"));
    });
    this.#drainFrames();
  }

  #drainFrames() {
    while (true) {
      const decoded = decodeOne(this.buffer);
      if (!decoded) return;
      this.buffer = this.buffer.subarray(decoded.consumed);
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(decoded.frame);
      } else {
        this.frames.push(decoded.frame);
      }
    }
  }

  #rejectWaiters(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  sendFrame(payload, options) {
    this.socket.write(clientFrame(payload, options));
  }

  sendJson(message, options) {
    this.sendFrame(JSON.stringify(message), options);
  }

  write(buffer) {
    this.socket.write(buffer);
  }

  async writeChunks(buffer, sizes = [1]) {
    let offset = 0;
    let index = 0;
    while (offset < buffer.length) {
      const size = Math.max(1, sizes[index % sizes.length]);
      const next = Math.min(buffer.length, offset + size);
      this.socket.write(buffer.subarray(offset, next));
      offset = next;
      index += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  nextFrame(timeoutMs = 1_000) {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    if (this.closed) {
      return Promise.reject(this.closeError || new Error("socket is closed"));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("timed out waiting for WebSocket frame"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async nextJson(timeoutMs = 1_000) {
    const frame = await this.nextFrame(timeoutMs);
    if (frame.opcode !== OPCODE.TEXT || !frame.fin) {
      throw new Error(`expected one text frame, received opcode ${frame.opcode}`);
    }
    return JSON.parse(frame.payload.toString("utf8"));
  }

  waitForSocketClose(timeoutMs = 1_000) {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for socket close"));
      }, timeoutMs);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  destroy() {
    this.socket.destroy();
  }
}

function requestHeaders({ host, port, key, origin, headers }) {
  const values = new Map([
    ["host", ["Host", `${host}:${port}`]],
    ["upgrade", ["Upgrade", "websocket"]],
    ["connection", ["Connection", "Upgrade"]],
    ["sec-websocket-key", ["Sec-WebSocket-Key", key]],
    ["sec-websocket-version", ["Sec-WebSocket-Version", "13"]],
    ["origin", ["Origin", origin]],
  ]);
  for (const [name, value] of Object.entries(headers || {})) {
    const normalized = name.toLowerCase();
    if (value === undefined || value === null) values.delete(normalized);
    else values.set(normalized, [name, String(value)]);
  }
  return [...values.values()].map(([name, value]) => `${name}: ${value}`).join("\r\n");
}

function parseHttpResponse(data) {
  const lines = data.toString("latin1").split("\r\n");
  const match = /^HTTP\/1\.1\s+(\d{3})\s*(.*)$/u.exec(lines.shift() || "");
  if (!match) throw new Error("invalid HTTP response status line");
  const headers = {};
  for (const line of lines) {
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { status: Number(match[1]), reason: match[2], headers };
}

export async function openRawWebSocket(options) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port;
  const path = options.path ?? "/extension";
  const method = options.method ?? "GET";
  const httpVersion = options.httpVersion ?? "1.1";
  const key = options.key ?? DEFAULT_KEY;
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const timeoutMs = options.timeoutMs ?? 1_000;
  const headers = requestHeaders({
    host,
    port,
    key,
    origin,
    headers: options.headers,
  });
  const request = Buffer.from(
    `${method} ${path} HTTP/${httpVersion}\r\n${headers}\r\n\r\n`,
    "latin1",
  );
  const tail = options.headFrame ? payloadBuffer(options.headFrame) : Buffer.alloc(0);
  const socket = createConnection({ host, port });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out connecting raw WebSocket"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", reject);
  });

  socket.write(Buffer.concat([request, tail]));
  const response = await new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for HTTP upgrade response"));
    }, timeoutMs);
    const onData = (chunk) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
      const boundary = buffered.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const responseBytes = buffered.subarray(0, boundary);
      const initialData = buffered.subarray(boundary + 4);
      cleanup();
      resolve({
        response: parseHttpResponse(responseBytes),
        initialData,
      });
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before HTTP upgrade response"));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });

  return {
    ...response,
    client: new RawWebSocketClient(socket, response.initialData),
  };
}

export async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition was not reached");
}
