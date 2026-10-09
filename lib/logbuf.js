'use strict';
/**
 * Tiny in-memory log ring buffer.
 *
 * Everything still goes to stdout (so `journalctl --user -u pocket-desktop`
 * works), but we also keep the last N lines so the app can hand the user a
 * ready-made diagnostics report without them touching the terminal.
 */

const MAX = 400;
const buffer = [];

function push(level, message, meta) {
  const entry = {
    t: new Date().toISOString(),
    level,
    message: String(message),
    ...(meta ? { meta } : {}),
  };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();

  const line = `[${entry.t.slice(11, 19)}] ${level.toUpperCase()} ${entry.message}${meta ? ' ' + JSON.stringify(meta) : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return entry;
}

const log = {
  info: (msg, meta) => push('info', msg, meta),
  warn: (msg, meta) => push('warn', msg, meta),
  error: (msg, meta) => push('error', msg, meta),
};

/** Most recent entries, optionally filtered. */
function recent({ limit = 200, level, contains } = {}) {
  let rows = buffer;
  if (level) rows = rows.filter((r) => r.level === level);
  if (contains) rows = rows.filter((r) => r.message.includes(contains));
  return rows.slice(-limit);
}

function clear() {
  buffer.length = 0;
}

module.exports = { log, recent, clear, MAX };
