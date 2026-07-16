# 🚀 Launch Checklist — Chanakya WhatsApp Bot

Code-side hardening is done (see "Already enforced by code" below). The items in
**Before go-live** are operator actions — they involve accounts and secrets the
code cannot set for itself.

## Before go-live (do these in order)

1. **Rotate exposed credentials.** The project folder was zipped
   (`chanakya-bot.zip`) *with the live `.env` inside*. If that zip was ever
   shared, uploaded, or emailed, treat every secret in it as leaked:
   - Meta access token → generate a fresh one (see step 3).
   - Cloudinary API secret → Cloudinary Console → Settings → Access Keys → regenerate.
   - Google service-account key → Google Cloud Console → IAM → Service Accounts →
     delete the old key, create a new one, re-apply with
     `node scripts/apply-google-credentials.js <new-key.json>`.
   - Delete the zip, or re-zip without `.env`.

2. **Set `META_APP_SECRET`** (currently empty in `.env`). Meta App → Settings →
   Basic → App Secret. Without it, in production the bot rejects **all**
   webhooks; in dev it accepts unsigned ones. Required for launch.

3. **Replace the temporary access token with a permanent System User token.**
   Temporary tokens expire in ~24 h — the #1 cause of a silently dead bot.
   Meta Business Suite → Business Settings → Users → System Users → Add →
   assign the WhatsApp asset → generate token with `whatsapp_business_messaging`.
   Verify with `npm run verify:meta`.

4. **Set production env on the host** (Railway → Variables):
   - `NODE_ENV=production` — enforces HMAC, fail-fast config, `/ready` protection.
   - `READINESS_SECRET=<long random>` — protects `GET /ready`.
   - `WEBHOOK_VERIFY_TOKEN=<long random>` — generate:
     `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
     (must match the value entered in Meta's webhook config).
   - `TRUST_PROXY=1` (default in production) — Railway sits one proxy hop in front.
   - `SKIP_WEBHOOK_SIGNATURE` — must NOT be set (it is ignored in production anyway).

5. **Persistent snapshot storage.** `data/repair_status_snapshot.json` is the
   status-poller's memory. On Railway the filesystem is ephemeral — attach a
   volume and point `REPAIR_STATUS_CACHE_PATH` at it, otherwise every redeploy
   re-baselines silently (no duplicate pings, but a status change during the
   deploy window is missed).

6. **WhatsApp Business profile:** display name approved, business verified,
   and the `broadcast_queue` templates approved in Meta before queuing any campaign.

7. **Smoke test on the live number** (one pass, ~5 minutes):
   repair flow end-to-end (with photo) → track the ticket → corporate flow →
   store locations → `terms` → `STOP` → confirm `opt_in_contacts` column D flips
   to FALSE → `RESUME`.

## Already enforced by code

- Webhook HMAC (`X-Hub-Signature-256`, timing-safe); `SKIP_WEBHOOK_SIGNATURE`
  ignored in production; unsigned webhooks rejected.
- Production fail-fast: missing Meta credentials abort startup with exit 1.
- Per-IP rate limiting keyed on `req.ip` via `trust proxy` (spoofed
  `X-Forwarded-For` no longer bypasses it); JSON body capped at 100 KB.
- Message dedup, session timeouts, per-phone corporate-lead throttle.
- IDOR guard on ticket tracking (only the submitting phone or an owner can view).
- Sheets formula-injection defence (`safeUserText`) on all user-entered cells.
- Outbound image/document URLs restricted to an HTTPS host allowlist.
- `STOP` / `RESUME` opt-out honoured globally, even mid-flow; broadcasts only
  reach `opted_in = TRUE`.
- Media downloads capped (16 MB) and time-limited; Cloudinary uploads retried
  with timeout; broadcast queue rows claimed before sending (no double-blast).
- Phone numbers redacted to last-4 in all logs; control chars stripped
  (log-injection defence).
- Security headers on every response (`X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`);
  `X-Powered-By` disabled. Terminal error handler returns bare status codes with
  no stack trace (malformed JSON → 400, oversized body → 413).
- `/ready` secret accepted via `X-Readiness-Secret` header (keeps it out of URLs
  and proxy logs) as well as the query param.
- Ticket-counter reads fail loudly instead of silently resetting to 0 — a
  transient Sheets error can no longer mint a duplicate ticket ID.
- Proactive jobs skip missing/invalid phone cells before calling the API, and a
  closed 24-hour window is logged as an explicit, actionable warning (see above).
- **Outbound circuit breaker**: per-minute + per-day caps on outbound messages
  (`OUTBOUND_MAX_PER_MIN`/`OUTBOUND_MAX_PER_DAY`, generous defaults) plus a panic
  kill switch (`OUTBOUND_KILL_SWITCH=1`) — a runaway loop, retry storm, or bad
  sheet row can't rack up a Meta bill or trip spam detection.
- **Broadcast recipient cap** (`BROADCAST_MAX_RECIPIENTS`, default 5000): a single
  bad queue row can't message an unbounded audience.
- Inbound messages get read receipts (blue ticks) so customers see responsiveness.
- Repair-photo Cloudinary IDs use a random token (no customer phone in the public
  image URL); corporate-lead logs carry no raw name/company (log-injection + PII).
- Security headers include HSTS (`Strict-Transport-Security`).
- `npm audit`: 0 known vulnerabilities (as of 2026-07-11; re-run monthly).

### Emergency stop
If the bot ever starts misbehaving in production, set `OUTBOUND_KILL_SWITCH=1`
and restart — inbound is still processed, but no outbound message goes out until
you clear it. This is your panic button while you investigate.

## Proactive notifications & the 24-hour window (IMPORTANT)

WhatsApp only lets you send **free-form** messages within 24 hours of the
customer's last message to you. After that, any business-initiated message must
be a **Meta-approved template**.

**Default posture: pull-only (free).** All proactive *customer* notifications are
OFF by default, so at launch the bot spends nothing on messaging — customers
check their own status any time via Track (free, inside the window). This also
means you don't need to create any templates to go live.

The proactive features, and how to turn each on later:

- Status-change pushes (`statusPoller`) — `STATUS_PUSH_MODE`:
  `off` (default) / `ready_only` (recommended once live) / `all`.
- Pickup reminders (`pickupReminder`) — `PICKUP_REMINDER_ENABLED=true`.
- Reassurance pings (`reassurancePing`) — `REASSURANCE_ENABLED=true`.
- Owner alerts (new ticket / lead) — **always on** (business ops, 2–3 recipients).

When you DO enable any customer push, remember it fires outside the 24-hour
window, so Meta requires an **approved utility template** (≈ ₹0.115 + GST each).
Create the template in Meta → WhatsApp Manager → Message Templates, then have the
developer wire `sendTemplateMessage` into that job. If a push is attempted
without a template while the window is closed, Meta returns **error 131047** and
the bot logs a clear `24-hour service window closed` warning (never a silent
failure).

**Recommendation:** launch pull-only. Once stable, turn on just
`STATUS_PUSH_MODE=ready_only` — the "your bag is ready" message is the only push
that pays for itself (it drives pickup + payment and clears storage).

## Operational notes

- `/health` — liveness (no deps). `/ready?secret=…` — checks Meta Graph credentials.
- Cron: status poll every 15 min (`STATUS_POLL_CRON`), broadcasts hourly,
  pickup reminders daily 09:00 server time, reassurance daily (`REASSURANCE_CRON`).
  Server TZ on Railway is UTC — IST is UTC+5:30, so "9 AM" cron fires 2:30 PM IST;
  adjust cron strings if that matters.
- Invalid cron strings in env now log an error and fall back to defaults
  (no more boot crash).
- Ticket counter lives in `repair_tickets!P1` — don't delete it.
- The bot is single-process by design (in-memory sessions, ticket-ID mutex).
  Do not scale to multiple instances without moving sessions + counter to a
  shared store (Redis).
