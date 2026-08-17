import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { TextDecoder } from "node:util";

// Canonical zero-dependency transport lives inside the portable Skill.
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const MAX_FRAME_HEADER_BYTES = 14;
const decoder = new TextDecoder("utf-8", { fatal: true });

function frame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function closePayload(code, reason) {
  const characters = [];
  let byteLength = 0;
  for (const character of String(reason)) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (byteLength + bytes > 123) break;
    characters.push(character);
    byteLength += bytes;
  }
  const reasonBytes = Buffer.from(characters.join(""), "utf8");
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}

function validCloseCode(code) {
  if (!Number.isInteger(code) || code < 1000 || code >= 5000) return false;
  if ([1004, 1005, 1006, 1015].includes(code)) return false;
  return code <= 1014 || code >= 3000;
}

function decodeUtf8(payload) {
  return decoder.decode(payload);
}

function isLoopback(address) {
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1";
}

function headerHasToken(value, token) {
  return typeof value === "string"
    && value.split(",").some((part) => part.trim().toLowerCase() === token);
}

function validWebSocketKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{22}==$/u.test(value)) return false;
  return Buffer.from(value, "base64").length === 16;
}

function rejectUpgrade(socket, status, label, extraHeaders = "") {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${label}\r\n`
    + "Connection: close\r\n"
    + "Content-Length: 0\r\n"
    + extraHeaders
    + "\r\n",
  );
}

export class ServerWebSocket extends EventEmitter {
  constructor(socket, options = {}) {
    super();
    this.socket = socket;
    this.readyState = OPEN;
    this.maxMessageBytes = options.maxMessageBytes ?? 8 * 1024 * 1024;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 16 * 1024 * 1024;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
    this.closeTimer = undefined;
    this.closeEmitted = false;
    this.closingCode = undefined;
    this.closingReason = "";

    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("end", () => {
      this.#emitClose(
        this.closingCode ?? 1006,
        this.closingCode ? this.closingReason : "socket ended",
      );
      socket.destroy();
    });
    socket.on("close", () => this.#emitClose(
      this.closingCode ?? 1006,
      this.closingCode ? this.closingReason : "socket closed",
    ));
    socket.on("error", (error) => {
      this.#emitClose(1006, error.message);
      socket.destroy();
    });
  }

  get bufferedAmount() {
    return this.socket.writableLength;
  }

  acceptHead(head) {
    if (head?.length) this.#onData(head);
  }

  sendText(text) {
    if (this.readyState !== OPEN) throw new Error("WebSocket is not open");
    const payload = Buffer.from(text, "utf8");
    const bytes = payload.length + MAX_FRAME_HEADER_BYTES;
    if (this.bufferedAmount + bytes > this.maxBufferedBytes) {
      this.fail(1013, "outbound backpressure");
      throw new Error("WebSocket outbound buffer exceeded");
    }
    this.socket.write(frame(0x1, payload));
  }

  sendPong(payload) {
    if (this.readyState !== OPEN) return;
    if (this.bufferedAmount + payload.length + MAX_FRAME_HEADER_BYTES > this.maxBufferedBytes) {
      this.fail(1013, "outbound backpressure");
      return;
    }
    this.socket.write(frame(0xA, payload));
  }

  close(code = 1000, reason = "") {
    if (this.readyState !== OPEN) return;
    if (!validCloseCode(code)) throw new RangeError("Invalid WebSocket close code");
    this.readyState = CLOSING;
    this.closingCode = code;
    this.closingReason = reason;
    this.socket.end(frame(0x8, closePayload(code, reason)));
    this.closeTimer = setTimeout(() => this.socket.destroy(), 1_000);
    this.closeTimer.unref?.();
  }

  fail(code, reason) {
    this.emit("protocolError", { code, reason });
    this.close(code, reason);
  }

  #onData(chunk) {
    if (this.readyState !== OPEN || !chunk.length) return;
    const buffered = this.buffer.length + chunk.length;
    if (buffered > this.maxMessageBytes + 64 * 1024) {
      this.fail(1009, "inbound buffer exceeded");
      return;
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    while (this.readyState === OPEN) {
      const consumed = this.#consumeFrame();
      if (consumed === 0) return;
      this.buffer = this.buffer.subarray(consumed);
    }
  }

  #consumeFrame() {
    if (this.buffer.length < 2) return 0;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const fin = Boolean(first & 0x80);
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;

    if (first & 0x70) return this.#invalid(1002, "RSV bits are not supported");
    if (!masked) return this.#invalid(1002, "client frames must be masked");

    if (length === 126) {
      if (this.buffer.length < 4) return 0;
      length = this.buffer.readUInt16BE(2);
      if (length < 126) return this.#invalid(1002, "non-minimal frame length");
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return 0;
      const largeLength = this.buffer.readBigUInt64BE(2);
      if (largeLength > BigInt(Number.MAX_SAFE_INTEGER) || largeLength < 65_536n) {
        return this.#invalid(1002, "invalid 64-bit frame length");
      }
      length = Number(largeLength);
      offset = 10;
    }

    const control = opcode >= 0x8;
    if (control && (!fin || length > 125)) {
      return this.#invalid(1002, "invalid control frame");
    }
    if (!control && length + this.fragmentBytes > this.maxMessageBytes) {
      return this.#invalid(1009, "message exceeds limit");
    }
    if (this.buffer.length < offset + 4 + length) return 0;

    const mask = this.buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index & 3];
    }
    const consumed = offset + 4 + length;

    if (opcode === 0x8) {
      this.#consumeClose(payload);
    } else if (opcode === 0x9) {
      this.sendPong(payload);
      this.emit("ping", payload);
    } else if (opcode === 0xA) {
      this.emit("pong", payload);
    } else if (opcode === 0x2) {
      return this.#invalid(1003, "binary messages are not supported");
    } else if (opcode === 0x1) {
      if (this.fragmentOpcode) return this.#invalid(1002, "new data frame during fragmentation");
      if (fin) this.#emitText(payload);
      else {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
      }
    } else if (opcode === 0x0) {
      if (!this.fragmentOpcode) return this.#invalid(1002, "unexpected continuation frame");
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (fin) {
        const message = Buffer.concat(this.fragments, this.fragmentBytes);
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmentOpcode = 0;
        this.#emitText(message);
      }
    } else {
      return this.#invalid(1002, "unsupported opcode");
    }
    return consumed;
  }

  #emitText(payload) {
    try {
      this.emit("message", decodeUtf8(payload));
    } catch {
      this.fail(1007, "invalid UTF-8");
    }
  }

  #consumeClose(payload) {
    if (payload.length === 1) {
      this.fail(1002, "invalid close payload");
      return;
    }
    let code = 1000;
    let reason = "";
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!validCloseCode(code)) {
        this.fail(1002, "invalid close code");
        return;
      }
      try {
        reason = decodeUtf8(payload.subarray(2));
      } catch {
        this.fail(1007, "invalid close reason");
        return;
      }
    }
    this.close(code, reason);
  }

  #invalid(code, reason) {
    this.fail(code, reason);
    return this.buffer.length;
  }

  #emitClose(code, reason) {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.readyState = CLOSED;
    this.emit("close", { code, reason });
  }
}

export function upgradeWebSocket(request, socket, head, options = {}) {
  socket.pause();
  const expectedPath = options.path ?? "/extension";
  if (!isLoopback(socket.remoteAddress)) {
    rejectUpgrade(socket, 403, "Forbidden");
    socket.resume();
    return undefined;
  }
  if (typeof options.hostAllowed === "function"
    && !options.hostAllowed(request.headers.host)) {
    rejectUpgrade(socket, 403, "Forbidden");
    socket.resume();
    return undefined;
  }
  if (typeof options.originAllowed === "function"
    && !options.originAllowed(request.headers.origin)) {
    rejectUpgrade(socket, 403, "Forbidden");
    socket.resume();
    return undefined;
  }
  if (request.method !== "GET") {
    rejectUpgrade(socket, 405, "Method Not Allowed");
    socket.resume();
    return undefined;
  }
  if (request.httpVersionMajor < 1
    || (request.httpVersionMajor === 1 && request.httpVersionMinor < 1)
    || typeof request.headers.host !== "string"
    || request.headers.host.length === 0) {
    rejectUpgrade(socket, 400, "Bad Request");
    socket.resume();
    return undefined;
  }
  if (request.url !== expectedPath) {
    rejectUpgrade(socket, 404, "Not Found");
    socket.resume();
    return undefined;
  }
  if (!headerHasToken(request.headers.upgrade, "websocket")
    || !headerHasToken(request.headers.connection, "upgrade")
    || !validWebSocketKey(request.headers["sec-websocket-key"])) {
    rejectUpgrade(socket, 400, "Bad Request");
    socket.resume();
    return undefined;
  }
  if (request.headers["sec-websocket-version"] !== "13") {
    rejectUpgrade(socket, 426, "Upgrade Required", "Sec-WebSocket-Version: 13\r\n");
    socket.resume();
    return undefined;
  }

  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}${GUID}`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n"
    + "Upgrade: websocket\r\n"
    + "Connection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${accept}\r\n`
    + "\r\n",
  );
  const websocket = new ServerWebSocket(socket, options);
  queueMicrotask(() => {
    websocket.acceptHead(head);
    socket.resume();
  });
  return websocket;
}

export const __test__ = {
  frame,
  isLoopback,
  validWebSocketKey,
};
