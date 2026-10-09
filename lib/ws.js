'use strict';
/**
 * Minimal RFC 6455 WebSocket server implementation.
 *
 * Only what we need: accept an upgrade, read masked frames from the client,
 * write binary frames back, handle ping/pong/close and continuation frames.
 * Keeping this in-tree means the app has zero npm dependencies.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024; // 16 MB
const SEND_CHUNK = 512 * 1024;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function isUpgradeRequest(req) {
  return (
    (req.headers.upgrade || '').toLowerCase() === 'websocket' &&
    (req.headers.connection || '').toLowerCase().split(',').map((s) => s.trim()).includes('upgrade')
  );
}

class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('net').Socket} socket already-handshaken TCP socket
   */
  constructor(socket, { maxMessage = MAX_MESSAGE } = {}) {
    super();
    this.socket = socket;
    this.maxMessage = maxMessage;
    this.readyState = 'open';
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentSize = 0;
    this._fragmentOpcode = 0;
    this.remoteAddress = socket.remoteAddress;
    this.closed = false;
    this.closeCode = null;
    this.closeReason = '';
    this.highWater = 2 * 1024 * 1024; // stop feeding us past this (resumed on drain)
    this.onbackpressure = null;        // set by the proxy: called with (paused)

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._onError(err));
    // A browser that goes away (tab closed, Wi-Fi dropped, app swiped) shows up
    // as 'end', NOT as 'close' — Node keeps the half-open socket alive until we
    // destroy it ourselves. Listening only for 'close' left every dropped
    // session running forever, still holding the screen server open.
    socket.on('end', () => this._finish(null));
    socket.on('close', () => this._finish(null));
    socket.setTimeout(0);
    socket.setNoDelay(true);
    // Detect a phone that vanished (Wi-Fi drop, app swiped away): without
    // keepalive a half-open TCP connection is never reported, so the session
    // would linger forever holding the screen server open.
    socket.setKeepAlive(true, 15000);
    // A socket that is paused does not report EOF or errors, so make sure we
    // are actually reading — otherwise disconnects go unnoticed.
    if (socket.isPaused()) socket.resume();
  }

  get bufferedAmount() {
    return this.socket.writableLength || 0;
  }

  /** Should the caller pause its source? */
  get congested() {
    return this.bufferedAmount > this.highWater;
  }

  /** Send a single message (Buffer or string). */
  send(data, { binary = true, fin = true } = {}) {
    if (this.closed) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    if (!fin || payload.length > SEND_CHUNK) {
      // Split large payloads into a fragmented message.
      let offset = 0;
      let first = true;
      while (offset < payload.length) {
        const slice = payload.subarray(offset, offset + SEND_CHUNK);
        offset += slice.length;
        const isLast = offset >= payload.length;
        this._writeFrame(first ? (binary ? 0x2 : 0x1) : 0x0, slice, isLast);
        first = false;
      }
      return true;
    }
    this._writeFrame(binary ? 0x2 : 0x1, payload, true);
    return true;
  }

  ping(payload = Buffer.alloc(0)) {
    this._writeFrame(0x9, Buffer.from(payload), true);
  }

  pong(payload = Buffer.alloc(0)) {
    this._writeFrame(0xa, Buffer.from(payload), true);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closeCode = code;
    this.closeReason = reason;
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._writeFrame(0x8, payload, true);
    this.closed = true;
    // Give the socket a moment to flush, then destroy it.
    setTimeout(() => {
      if (!this.socket.destroyed) this.socket.destroy();
    }, 250).unref?.();
    this.readyState = 'closing';
  }

  /** Hard-close the underlying socket. */
  destroy() {
    this.closed = true;
    this.socket.destroy();
  }

  _writeFrame(opcode, payload, fin) {
    try {
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      header[0] = (fin ? 0x80 : 0x00) | opcode;
      this.socket.write(header);
      this.socket.write(payload);
      if (this.onbackpressure) this.onbackpressure(this.congested);
    } catch (err) {
      this._onError(err);
    }
  }

  _onError(err) {
    this.emit('error', err);
    this.destroy();
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    try {
      while (this._parseFrame()) {
        /* consume as many frames as available */
      }
    } catch (err) {
      this.close(1002, 'protocol error');
      this.emit('error', err);
    }
  }

  /** @returns {boolean} true when another frame may be available */
  _parseFrame() {
    const buf = this._buf;
    if (buf.length < 2) return false;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (rsv !== 0) throw new Error('RSV bits set');
    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessage)) throw new Error('frame too large');
      len = Number(big);
      offset = 10;
    }
    if (!masked) throw new Error('client frame must be masked');
    if (len > this.maxMessage) throw new Error('frame too large');

    const maskStart = offset;
    offset += 4;
    if (buf.length < offset + len) return false;

    const payload = Buffer.allocUnsafe(len);
    buf.copy(payload, 0, offset, offset + len);
    const mask = buf.subarray(maskStart, maskStart + 4);
    for (let i = 0; i < len; i += 1) payload[i] ^= mask[i & 3];

    this._buf = buf.subarray(offset + len);

    switch (opcode) {
      case 0x0: // continuation
        if (!this._fragmentOpcode) throw new Error('unexpected continuation');
        this._fragmentSize += payload.length;
        if (this._fragmentSize > this.maxMessage) throw new Error('message too large');
        this._fragments.push(payload);
        if (fin) {
          const message = Buffer.concat(this._fragments);
          const op = this._fragmentOpcode;
          this._fragments = [];
          this._fragmentSize = 0;
          this._fragmentOpcode = 0;
          this._emitMessage(message, op === 0x2);
        }
        break;
      case 0x1: // text
      case 0x2: // binary
        if (fin) {
          this._emitMessage(payload, opcode === 0x2);
        } else {
          this._fragmentOpcode = opcode;
          this._fragments = [payload];
          this._fragmentSize = payload.length;
        }
        break;
      case 0x8: { // close
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!this.closed) this._writeFrame(0x8, payload, true);
        this.closed = true;
        this.readyState = 'closed';
        this.closeCode = code;
        this.closeReason = reason;
        this.emit('close', code, reason, true);
        this.socket.end();
        break;
      }
      case 0x9: // ping
        if (!this.closed) this.pong(payload);
        break;
      case 0xa: // pong
        this.emit('pong');
        break;
      default:
        throw new Error('unsupported opcode ' + opcode);
    }
    return this._buf.length >= 2;
  }

  _emitMessage(buffer, isBinary) {
    this.emit('message', buffer, isBinary);
  }

  _finish() {
    if (this.closed && this.readyState === 'closed') return;
    this.closed = true;
    this.readyState = 'closed';
    this.emit('close', 1006, '', false);
    // Free the descriptor: on a half-close nothing else will.
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

/**
 * Attach a WebSocket to an HTTP upgrade request.
 * Returns the connection; the caller is expected to have validated auth already.
 */
function accept(req, socket, head, options = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return null;
  }
  const protocol = req.headers['sec-websocket-protocol'];
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ];
  if (protocol) {
    const chosen = String(protocol).split(',').map((s) => s.trim()).includes('binary')
      ? 'binary'
      : String(protocol).split(',')[0].trim();
    if (chosen) headers.push(`Sec-WebSocket-Protocol: ${chosen}`);
  }
  socket.write(headers.join('\r\n') + '\r\n\r\n');
  const conn = new WebSocketConnection(socket, options);
  if (head && head.length) conn._onData(head);
  return conn;
}

module.exports = { accept, isUpgradeRequest, acceptKey, WebSocketConnection };
