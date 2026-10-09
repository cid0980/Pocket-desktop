'use strict';
/**
 * Authentication: a single PIN (set on first run) + stateless signed session
 * tokens stored in an HttpOnly cookie. Nothing here depends on npm packages.
 */

const crypto = require('crypto');
const config = require('./config');

const PBKDF2_ITERATIONS = 210000;
const TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const COOKIE_NAME = 'pd_session';
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_BASE_MS = 30 * 1000;      // first lockout: 30s
const LOCKOUT_MAX_MS = 60 * 60 * 1000;  // doubling caps out at an hour

/** ip -> { count, first, lockedUntil, strikes } */
const attempts = new Map();

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto
    .pbkdf2Sync(String(pin), Buffer.from(salt, 'hex'), PBKDF2_ITERATIONS, 32, 'sha256')
    .toString('hex');
  return { salt, hash };
}

function verifyPin(pin, salt, hash) {
  if (!salt || !hash) return false;
  const candidate = crypto.pbkdf2Sync(String(pin), Buffer.from(salt, 'hex'), PBKDF2_ITERATIONS, 32, 'sha256');
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function hasPin() {
  const cfg = config.load();
  return Boolean(cfg.pinHash && cfg.pinSalt);
}

function setPin(pin) {
  validatePinFormat(pin);
  const { salt, hash } = hashPin(pin);
  config.save({ pinSalt: salt, pinHash: hash });
  return true;
}

function validatePinFormat(pin) {
  if (!/^[0-9]{4,10}$/.test(String(pin || ''))) {
    const err = new Error('PIN must be 4-10 digits');
    err.statusCode = 400;
    throw err;
  }
}

function sign(payloadObj) {
  const cfg = config.load();
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const mac = crypto.createHmac('sha256', cfg.tokenSecret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const cfg = config.load();
  const expected = crypto.createHmac('sha256', cfg.tokenSecret).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data.exp || Date.now() > data.exp) return null;
  return data;
}

function createSession(meta = {}) {
  const now = Date.now();
  const token = sign({ iat: now, exp: now + TOKEN_TTL_MS, v: 1, ...meta });
  return { token, expires: new Date(now + TOKEN_TTL_MS), maxAge: Math.floor(TOKEN_TTL_MS / 1000) };
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      // A stray "%" or bad escape in any cookie must never break the request
      // (it used to throw and take the whole WebSocket upgrade down with it).
      out[name] = raw;
    }
  }
  return out;
}

function sessionCookie(session, { secure = false } = {}) {
  const bits = [
    `${COOKIE_NAME}=${session.token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${session.maxAge}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Returns the token payload for the request, or null when not signed in. */
function getSession(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies[COOKIE_NAME]);
}

function isAuthed(req) {
  return Boolean(getSession(req));
}

function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = attempts.get(ip);
  if (rec?.lockedUntil && now < rec.lockedUntil) {
    const err = new Error(`Too many attempts. Try again in ${Math.ceil((rec.lockedUntil - now) / 1000)}s`);
    err.statusCode = 429;
    throw err;
  }
  if (rec && now - rec.first > ATTEMPT_WINDOW_MS) attempts.delete(ip);
  return true;
}

function recordFailure(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, first: now, lockedUntil: 0 };
  if (now - rec.first > ATTEMPT_WINDOW_MS) {
    rec.count = 0;
    rec.first = now;
  }
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    // progressive: each new lockout lasts twice as long as the previous one
    rec.strikes = (rec.strikes || 0) + 1;
    rec.lockedUntil = now + Math.min(LOCKOUT_BASE_MS * 2 ** (rec.strikes - 1), LOCKOUT_MAX_MS);
    rec.count = 0;
    rec.first = now;
  }
  attempts.set(ip, rec);
  return rec;
}

function clearFailures(req) {
  attempts.delete(clientIp(req));
}

/** Milliseconds left in the current lockout (0 when not locked). */
function lockoutRemaining(req) {
  const rec = attempts.get(clientIp(req));
  return rec?.lockedUntil ? Math.max(0, rec.lockedUntil - Date.now()) : 0;
}

module.exports = {
  COOKIE_NAME,
  hasPin,
  setPin,
  verifyPin,
  validatePinFormat,
  createSession,
  sign,
  verifyToken,
  getSession,
  isAuthed,
  sessionCookie,
  clearCookie,
  parseCookies,
  checkRateLimit,
  recordFailure,
  clearFailures,
  lockoutRemaining,
};
