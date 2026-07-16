require('dotenv').config();
const express = require('express');

function logConfigWarnings() {
  let tokenRaw = process.env.META_ACCESS_TOKEN;
  try {
    // Same cleanup as whatsapp.js (duplicate minimal logic to avoid load-order coupling)
    if (tokenRaw != null) {
      tokenRaw = String(tokenRaw).replace(/^\ufeff/, '').trim();
      if ((tokenRaw.startsWith('"') && tokenRaw.endsWith('"')) || (tokenRaw.startsWith("'") && tokenRaw.endsWith("'"))) {
        tokenRaw = tokenRaw.slice(1, -1).trim();
      }
    }
  } catch { /* noop */ }
  const token = tokenRaw?.trim() || '';
  const phoneId = process.env.META_PHONE_NUMBER_ID?.trim();
  const verify = process.env.WEBHOOK_VERIFY_TOKEN;
  if (!token) console.warn('[CONFIG] META_ACCESS_TOKEN is missing — outbound WhatsApp messages will fail.');
  else if (token.length < 30) console.warn('[CONFIG] META_ACCESS_TOKEN looks too short — double-check paste (no spaces/quotes truncation).');

  if (!phoneId) console.warn('[CONFIG] META_PHONE_NUMBER_ID is missing — Graph URL will be invalid.');
  if (!verify) console.warn('[CONFIG] WEBHOOK_VERIFY_TOKEN is missing — Meta GET /webhook verification will return 403.');
  const secret = process.env.META_APP_SECRET?.trim();
  if (!secret) console.warn('[CONFIG] META_APP_SECRET is empty — signature verification is skipped (dev only). Set it in production.');
  if (process.env.SKIP_WEBHOOK_SIGNATURE === '1' || process.env.SKIP_WEBHOOK_SIGNATURE === 'true') {
    console.warn('[CONFIG] SKIP_WEBHOOK_SIGNATURE is set — Meta HMAC will not be checked.');
  }
  ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'].forEach((k) => {
    if (!process.env[k]?.trim()) {
      console.warn(`[CONFIG] ${k} is missing — repair photos will not upload; sheet previews stay empty until set.`);
    }
  });
  if (!process.env.GOOGLE_SHEETS_ID?.trim()) {
    console.warn('[CONFIG] GOOGLE_SHEETS_ID is missing — ticketing & catalog write/read will fail.');
  }

  // In production a missing credential means the bot either can't talk to
  // customers (token/phone id) or would drop every inbound webhook (app secret,
  // verify token). Booting anyway just hides the outage — refuse to start.
  if (process.env.NODE_ENV === 'production') {
    const missing = [];
    if (!token) missing.push('META_ACCESS_TOKEN');
    if (!phoneId) missing.push('META_PHONE_NUMBER_ID');
    if (!verify) missing.push('WEBHOOK_VERIFY_TOKEN');
    if (!secret) missing.push('META_APP_SECRET');
    if (missing.length) {
      console.error(`[CONFIG] FATAL: NODE_ENV=production but required env missing: ${missing.join(', ')}. Refusing to start.`);
      process.exit(1);
    }
  }
}
logConfigWarnings();
const cron = require('node-cron');
const { verifyMetaWhatsAppCredentials } = require('./services/whatsapp');
const { verifyWebhook } = require('./webhook/verify');
const { handleWebhook } = require('./webhook/handler');
const { pollStatusChanges } = require('./jobs/statusPoller');
const { runBroadcastQueue } = require('./jobs/broadcastRunner');
const { sendPickupReminders } = require('./jobs/pickupReminder');
const { sendStaleTicketReassurance } = require('./jobs/reassurancePing');

const app = express();

// Hide the Express fingerprint so scanners get less info about the stack.
app.disable('x-powered-by');

// Minimal security headers (hand-rolled — no helmet dependency for a webhook API).
// nosniff: stop content-type sniffing. no-store: these are dynamic/health/credential
// responses that must never be cached by a proxy. Referrer + frame hardening are
// cheap defence-in-depth even though there's no browser UI.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  // Pin HTTPS for browsers (ignored over plain HTTP, so harmless behind a
  // TLS-terminating proxy; Meta as a non-browser client ignores it too).
  res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// Behind a reverse proxy (Railway/Render/ngrok) the client IP arrives in
// X-Forwarded-For. Express only honours that header for req.ip when
// 'trust proxy' is set — and we only set it when the operator says we ARE
// behind a proxy (TRUST_PROXY hops, default 1 in production). Never derive
// the rate-limit key from the raw XFF header: clients can forge it freely,
// which hands out a fresh rate-limit bucket per request.
const trustProxyHops = Number(process.env.TRUST_PROXY ?? (process.env.NODE_ENV === 'production' ? 1 : 0));
if (Number.isFinite(trustProxyHops) && trustProxyHops > 0) {
  app.set('trust proxy', trustProxyHops);
}

// Body size cap — Meta webhooks are typically 1–5 KB per event.
// 100 KB gives >20x headroom while defanging JSON-bomb DoS attempts.
app.use(express.json({
  limit: '100kb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

/**
 * Simple in-memory per-IP rate limiter (fixed-window). No new deps.
 *
 * We're intentionally conservative: legitimate Meta traffic is far below 60
 * requests/minute per source IP, and a real customer texting the bot generates
 * about one webhook per action. Anything above the cap is very likely spam or
 * scanning, and we drop it with 429.
 *
 * State grows only with unique IPs; we evict entries older than 2 windows to
 * bound memory.
 */
function makeRateLimiter({ windowMs, max, name = 'default' }) {
  const buckets = new Map(); // ip -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) if (b.resetAt < now - windowMs) buckets.delete(ip);
  }, windowMs).unref();

  return function rateLimit(req, res, next) {
    // req.ip respects 'trust proxy' (set above), so behind a configured proxy it is
    // the real client IP, and locally it's the socket peer. Never read XFF directly —
    // it is attacker-controlled and would let each request mint its own bucket.
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, b);
    }
    b.count++;
    if (b.count > max) {
      console.warn(`[RATE-LIMIT/${name}] ${ip} exceeded ${max}/${windowMs}ms (count=${b.count})`);
      res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
      return res.status(429).send('Too Many Requests');
    }
    next();
  };
}

const webhookRateLimit = makeRateLimiter({ windowMs: 60 * 1000, max: 120, name: 'webhook' });
const readyRateLimit   = makeRateLimiter({ windowMs: 60 * 1000, max: 10,  name: 'ready' });

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => res.send('Chanakya Bot is running! 🎒'));

/** Liveness: no external deps (use for uptime monitors). */
app.get('/health', (req, res) => res.json({ ok: true, service: 'chanakya-bot', uptime_sec: Math.floor(process.uptime()) }));

/** Readiness: verifies Meta Graph can read this Phone number ID + token (no message sent).
 * READINESS_SECRET is REQUIRED in production so /ready doesn't fingerprint the WhatsApp
 * account to anyone who can hit the URL. Call as GET /ready?secret=YOUR_VALUE.
 * In development the secret is optional (dev loop convenience). */
app.get('/ready', readyRateLimit, async (req, res) => {
  const need = process.env.READINESS_SECRET?.trim();
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && !need) {
    console.error('[READY] Blocked: READINESS_SECRET is not set in production.');
    return res.sendStatus(404);
  }
  if (need) {
    // Prefer the header (keeps the secret out of URLs / proxy access logs);
    // fall back to the query param for convenience.
    const provided = String(req.get('x-readiness-secret') || req.query.secret || '');
    // Length + timing-safe compare so we don't leak length or short-circuit on mismatch.
    const okLen = provided.length === need.length;
    let match = okLen;
    if (okLen) {
      try {
        match = require('crypto').timingSafeEqual(Buffer.from(provided), Buffer.from(need));
      } catch { match = false; }
    }
    if (!match) return res.sendStatus(404);
  }
  try {
    const detail = await verifyMetaWhatsAppCredentials();
    const http = detail.ok ? 200 : 503;
    res.status(http).json({
      whatsapp_credentials: detail.ok ? 'ok' : 'fail',
      detail,
    });
  } catch (e) {
    res.status(503).json({ whatsapp_credentials: 'error', message: String(e.message) });
  }
});

// ── Meta webhook verification (GET) ──────────────────────────
app.get('/webhook', webhookRateLimit, verifyWebhook);

// ── Incoming messages (POST) ──────────────────────────────────
app.post('/webhook', webhookRateLimit, handleWebhook);

// Terminal error handler. Catches body-parser errors (malformed JSON, payload
// over the 100 KB cap) and anything else that reaches Express, and returns a
// bare status with NO stack trace or error detail in the body — a scanner
// probing the endpoint learns nothing about the stack. Must have 4 args.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 400;
  console.warn(`[HTTP] ${req.method} ${req.path} rejected: ${err.type || err.message}`);
  if (res.headersSent) return;
  res.status(status).send(status === 413 ? 'Payload Too Large' : 'Bad Request');
});

// ── Cron jobs ─────────────────────────────────────────────────
// Re-entrancy guard: if a job overruns its schedule, node-cron will fire another
// instance concurrently. That's how you get duplicate "your bag is ready" pings.
// runOnceAtATime() wraps each job in a per-name running flag so overlapping ticks
// are skipped (with a warning) instead of racing.
const _cronRunning = new Set();
function runOnceAtATime(name, fn) {
  return async () => {
    if (_cronRunning.has(name)) {
      console.warn(`[CRON/${name}] previous run still in progress — skipping this tick`);
      return;
    }
    _cronRunning.add(name);
    const t0 = Date.now();
    try {
      console.log(`[CRON/${name}] start`);
      await fn();
      console.log(`[CRON/${name}] done in ${Date.now() - t0}ms`);
    } catch (e) {
      console.error(`[CRON/${name}] failed after ${Date.now() - t0}ms:`, e.message);
    } finally {
      _cronRunning.delete(name);
    }
  };
}

// A typo'd cron string in .env would throw inside cron.schedule and take the
// whole bot down at boot. Validate and fall back to the built-in default instead.
function cronOrDefault(envValue, fallback, name) {
  const v = envValue?.trim();
  if (!v) return fallback;
  if (cron.validate(v)) return v;
  console.error(`[CRON] Invalid cron expression for ${name}: "${v}" — using default "${fallback}".`);
  return fallback;
}

// Repair sheet status → WhatsApp push (default: every 15 min). Shorten with STATUS_POLL_CRON e.g. */5 * * * *
cron.schedule(
  cronOrDefault(process.env.STATUS_POLL_CRON, '*/15 * * * *', 'STATUS_POLL_CRON'),
  runOnceAtATime('statusPoller', pollStatusChanges),
);

// Every hour: check broadcast queue
cron.schedule('0 * * * *', runOnceAtATime('broadcastQueue', runBroadcastQueue));

// Every day at 9am: send pickup reminders (bags uncollected 7+ days)
cron.schedule('0 9 * * *', runOnceAtATime('pickupReminder', sendPickupReminders));

// Daily reassurance when ticket row unchanged (updated_at) — default 04:30 UTC ≈ 10:00 IST
cron.schedule(
  cronOrDefault(process.env.REASSURANCE_CRON, '30 4 * * *', 'REASSURANCE_CRON'),
  runOnceAtATime('reassurance', sendStaleTicketReassurance),
);

// ── Start server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  console.log(`\n🎒 Chanakya Bot server running on port ${PORT}`);
  console.log(`   Local:   http://localhost:${PORT}/webhook`);
  console.log(`   Health:  http://localhost:${PORT}/health`);
  console.log(`   Ready:   http://localhost:${PORT}/ready`);
  console.log('');
  console.log('   ⚠️  Meta cannot call localhost. Use a public HTTPS URL (ngrok, Cloudflare Tunnel,');
  console.log('      Railway, Render, etc.) and set Webhook URL to: https://YOUR_HOST/webhook');
  console.log('      You should see [WEBHOOK] inbound in this terminal when a WhatsApp message arrives.\n');

  const skipStartupMeta =
    process.env.META_STARTUP_CHECK === '0'
    || String(process.env.META_STARTUP_CHECK || '').toLowerCase() === 'false';
  if (skipStartupMeta) return;

  const r = await verifyMetaWhatsAppCredentials();
  if (r.ok) {
    console.log(`[META] Startup check OK (display: ${r.displayPhoneNumber || r.phoneNumberId})\n`);
  } else {
    console.error('[META] Startup check FAILED — outbound WhatsApp sends will error until fixed:', r.message || r.hint || JSON.stringify(r));
    console.error('       Run: npm run verify:meta — then paste a new META_ACCESS_TOKEN from Meta App → WhatsApp → API Setup.\n');
  }
});

// Graceful shutdown — stop accepting new connections, let in-flight webhook responses finish.
// Render / Railway / most hosts send SIGTERM before killing; we get up to ~10s to drain.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[SHUTDOWN] ${signal} received — draining connections…`);
  server.close(() => {
    console.log('[SHUTDOWN] Server closed. Bye.');
    process.exit(0);
  });
  // Hard-kill after 8s if something is stuck
  setTimeout(() => {
    console.error('[SHUTDOWN] Force-exit after 8s — some connections did not drain.');
    process.exit(1);
  }, 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Last-resort safety net so an unhandled promise doesn't silently break the bot
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  // Exit so process supervisor restarts us cleanly rather than running in a bad state
  shutdown('uncaughtException');
});
