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

  try {
    const { getGeneralOwnerPhones } = require('./utils/ownerPhones');
    const owners = getGeneralOwnerPhones();
    if (!owners.length) {
      console.warn('[CONFIG] No OWNER_PHONE_* set — ticket/lead/handoff/health alerts will go nowhere.');
    } else {
      const redacted = owners.map((p) => (p.length > 4 ? '***' + p.slice(-4) : '***')).join(', ');
      console.warn(
        `[CONFIG] Owner alerts are free-form. ${owners.length} owner(s) (${redacted}) must message this WhatsApp number at least once every 24h or alerts fail with Meta 131047.`,
      );
    }
  } catch { /* ownerPhones is best-effort at boot */ }

  try {
    const { missingTemplateEnv, repairUpdatesReady, feedbackTemplatesReady } = require('./utils/metaTemplates');
    if (!repairUpdatesReady()) {
      console.warn('[CONFIG] REPAIR_UPDATE_TEMPLATE_EN/HI/GU unset — status pushes and the post-booking opt-in question are off until Meta approves those Utility templates.');
    }
    if (!feedbackTemplatesReady()) {
      console.warn('[CONFIG] FEEDBACK_TEMPLATE_EN/HI/GU unset — post-pickup ratings will not be requested until those templates are approved.');
    }
    const missing = missingTemplateEnv();
    if (missing.length && process.env.NODE_ENV === 'production') {
      console.warn('[CONFIG] Template env still empty:', missing.join(', '));
    }
  } catch { /* templates helper is best-effort at boot */ }

  if (!process.env.TERMS_URL?.trim() && !process.env.TERMS_DOC_URL?.trim()) {
    console.warn('[CONFIG] TERMS_URL and TERMS_DOC_URL are empty — customers get the summary text only, no link or PDF.');
  }

  // In production a missing credential means the bot either can't talk to
  // customers (token/phone id), would drop every inbound webhook (app secret,
  // verify token), can't create/look up tickets (Sheets), or can't store
  // repair photos (Cloudinary). Booting anyway just hides the outage — refuse to start.
  if (process.env.NODE_ENV === 'production') {
    const missing = [];
    if (!token) missing.push('META_ACCESS_TOKEN');
    if (!phoneId) missing.push('META_PHONE_NUMBER_ID');
    if (!verify) missing.push('WEBHOOK_VERIFY_TOKEN');
    if (!secret) missing.push('META_APP_SECRET');
    if (!process.env.GOOGLE_SHEETS_ID?.trim()) missing.push('GOOGLE_SHEETS_ID');
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim()) missing.push('GOOGLE_SERVICE_ACCOUNT_EMAIL');
    if (!process.env.GOOGLE_PRIVATE_KEY?.trim()) missing.push('GOOGLE_PRIVATE_KEY');
    if (!process.env.CLOUDINARY_CLOUD_NAME?.trim()) missing.push('CLOUDINARY_CLOUD_NAME');
    if (!process.env.CLOUDINARY_API_KEY?.trim()) missing.push('CLOUDINARY_API_KEY');
    if (!process.env.CLOUDINARY_API_SECRET?.trim()) missing.push('CLOUDINARY_API_SECRET');
    if (missing.length) {
      console.error(`[CONFIG] FATAL: NODE_ENV=production but required env missing: ${missing.join(', ')}. Refusing to start.`);
      process.exit(1);
    }
  }
}
logConfigWarnings();

// Verify the directories holding state that must survive a redeploy are
// writable and look like a mounted volume rather than an ephemeral container
// filesystem. In production a missing/unwritable DATA_DIR is fatal — same
// stance as a missing Meta or Sheets credential above, and for the same
// reason: limping along silently is worse than not starting. Dev and staging
// warn only.
const { checkPersistence } = require('./utils/persistenceCheck');
const _persistence = checkPersistence();
if (_persistence.fatal) {
  console.error(`[CONFIG] FATAL: ${_persistence.fatalReasons.join(' ')} Refusing to start.`);
  process.exit(1);
}

const cron = require('node-cron');
const { verifyMetaWhatsAppCredentials } = require('./services/whatsapp');
const { verifyWebhook } = require('./webhook/verify');
const { handleWebhook } = require('./webhook/handler');
const { pollStatusChanges } = require('./jobs/statusPoller');
const { runBroadcastQueue } = require('./jobs/broadcastRunner');
const { sendPickupReminders } = require('./jobs/pickupReminder');
const { sendFeedbackRequests } = require('./jobs/feedbackRequest');
const { runHealthCheck } = require('./jobs/healthCheck');

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

// Proactive repair-status updates to opted-in customers (default: every 15 min).
// The job itself enforces the 10:00-19:00 IST send window, so running it often
// is harmless — out-of-window ticks just log and return.
cron.schedule(
  cronOrDefault(process.env.STATUS_POLL_CRON, '*/15 * * * *', 'STATUS_POLL_CRON'),
  runOnceAtATime('statusPoller', pollStatusChanges),
);

// Every hour: check broadcast queue
cron.schedule('0 * * * *', runOnceAtATime('broadcastQueue', runBroadcastQueue));

// Pickup reminders (bags uncollected 7+ days). Off until PICKUP_REMINDER_ENABLED=true.
// Default 04:30 UTC = 10:00 IST on a UTC host (Railway). If you set TZ=Asia/Kolkata
// on the service, override with PICKUP_REMINDER_CRON=0 10 * * *. The job also
// respects the IST quiet-hours window.
cron.schedule(
  cronOrDefault(process.env.PICKUP_REMINDER_CRON, '30 4 * * *', 'PICKUP_REMINDER_CRON'),
  runOnceAtATime('pickupReminder', sendPickupReminders),
);

// Post-pickup feedback requests. Runs hourly; the job itself enforces the
// FEEDBACK_DELAY_HOURS wait and the same quiet-hours window as the poller,
// so an hourly tick just means "check whether anyone is due".
cron.schedule(
  cronOrDefault(process.env.FEEDBACK_CRON, '15 * * * *', 'FEEDBACK_CRON'),
  runOnceAtATime('feedbackRequest', sendFeedbackRequests),
);

// Health check: probes Meta + Sheets and WhatsApps the owners if either stays
// broken. The bot fails silently otherwise — it stays up and answers /health
// while being unable to send a single message.
cron.schedule(
  cronOrDefault(process.env.HEALTH_CHECK_CRON, '*/30 * * * *', 'HEALTH_CHECK_CRON'),
  runOnceAtATime('healthCheck', runHealthCheck),
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

  // Sheets was only ever presence-checked: a malformed or revoked private key
  // passed the "is it set?" test at boot and then failed on the first real
  // customer, who got "please call the store" for a problem that was ours.
  // One live read makes it fail here instead, next to the fix.
  await verifySheetsAccess();
});

/**
 * Prove the Sheets credentials actually work — a read, never a write.
 *
 * In production this is fatal, matching how a missing credential already
 * behaves: a bot that cannot reach the sheet can neither create nor look up a
 * ticket, so almost nothing it offers a customer works. Elsewhere it warns,
 * so the flows that do not need Sheets are still developable offline.
 */
async function verifySheetsAccess() {
  const { readTicketRows } = require('./services/sheets');
  try {
    const rows = await readTicketRows({ fresh: true, noRetry: true });
    console.log(`[SHEETS] Startup check OK (repair_tickets readable, ${Math.max(0, rows.length - 1)} ticket row(s))\n`);
    return true;
  } catch (e) {
    const detail = e.message || String(e);
    if (process.env.NODE_ENV === 'production') {
      console.error(
        `[SHEETS] FATAL: cannot read the spreadsheet — ${detail}\n`
        + '       Check GOOGLE_PRIVATE_KEY is the full key including the BEGIN/END lines and\n'
        + '       the \\n escapes, that GOOGLE_SHEETS_ID is right, and that the sheet is shared\n'
        + '       with GOOGLE_SERVICE_ACCOUNT_EMAIL as Editor. Run: npm run verify:sheet\n'
        + '       Refusing to start — ticket creation and tracking would both fail.',
      );
      process.exit(1);
    }
    console.error(
      `[SHEETS] Startup check FAILED — ticket create/lookup will error until fixed: ${detail}`,
    );
    console.error('       Run: npm run verify:sheet\n');
    return false;
  }
}

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
