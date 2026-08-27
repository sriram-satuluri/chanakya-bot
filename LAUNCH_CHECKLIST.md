# Launch Checklist — Chanakya WhatsApp Bot

Code-side hardening is in place (see "Already enforced by code"). **Before
go-live** items are operator actions — accounts and secrets the code cannot
set for itself.

Status-poller memory is **not** a local snapshot file. Ticket opt-in / last
sent / failure counts live in `repair_tickets` columns Q–Y. The files that
must survive a Railway redeploy are under `data/` (sessions, dedup,
throttles, health counters).

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

2. **Set `META_APP_SECRET`**. Meta App → Settings → Basic → App Secret.
   Without it, in production the bot rejects **all** webhooks. Required for launch.

3. **Replace the temporary access token with a permanent System User token.**
   Temporary tokens expire in ~24 h — the #1 cause of a silently dead bot.
   Meta Business Suite → Business Settings → Users → System Users → Add →
   assign the WhatsApp asset → generate token with `whatsapp_business_messaging`
   and `whatsapp_business_management`. Verify with `npm run verify:meta`.

4. **Production WhatsApp number** — not the sandbox `+1 555-…` test line.
   Display name approved, business verified, payment method on the WABA.
   If Sold-To country is India, use INR billing (migration deadline 31 Dec 2026).
   Confirm with Vedant/Vatsal whether the live number already runs WhatsApp
   Business app: registering it on Cloud API *without coexistence* logs the
   app out of the phone.

5. **Submit and wait for Utility templates (24–48 h).** The bot will **not**
   send status updates or feedback, and will **not** ask "Yes, update me" after
   booking, until these env vars are set to *approved* names:

   ### repair_status_update_en / _hi / _gu (category: Utility)

   Language codes `en`, `hi`, `gu`. Four body variables.

   English body (submit Hindi/Gujarati as real translations, not English tagged `hi`):

   `Hi {{1}}, your repair {{2}} is now: {{3}}. Collect or enquire at {{4}}.`

   Then set `REPAIR_UPDATE_TEMPLATE_EN/HI/GU`.

   ### repair_feedback_en / _hi / _gu (category: Utility)

   Two body variables. Three quick-reply buttons whose payloads **must** be
   `rate_1`, `rate_3`, `rate_5` (this is what the bot matches).

   English body: `Hi {{1}}, how was the repair on ticket {{2}}? Tap a rating.`

   Button titles e.g. `1 – Poor` / `3 – OK` / `5 – Excellent`.

   Then set `FEEDBACK_TEMPLATE_EN/HI/GU`.

   Marketing/`broadcast_queue` templates are separate — do not queue a campaign
   until those are approved.

6. **Set production env on the host** (Railway → Variables):
   - `NODE_ENV=production` — enforces HMAC, fail-fast config, `/ready` protection.
   - `READINESS_SECRET=<long random>` — protects `GET /ready`.
   - `WEBHOOK_VERIFY_TOKEN=<long random>` — generate:
     `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
     (must match the value entered in Meta's webhook config).
   - `TRUST_PROXY=1` (default in production) — Railway sits one proxy hop in front.
   - `SKIP_WEBHOOK_SIGNATURE` — must NOT be set (it is ignored in production anyway).
   - `META_PHONE_NUMBER_ID` — the **production** number ID, not the sandbox one.
   - `OWNER_PHONE_VEDANT` / `OWNER_PHONE_VATSAL` as `91…` digits.
   - Cache paths on the volume (next step).

7. **Persistent volume.** Railway’s container disk is wiped on every deploy.
   Mount a volume at `/data` and set:
   - `SESSION_CACHE_PATH=/data/sessions.json`
   - `DEDUP_CACHE_PATH=/data/processed_messages.json`
   - `THROTTLE_CACHE_PATH=/data/throttles.json`
   - `HEALTH_CACHE_PATH=/data/health_state.json`

   Run **one replica only**. Sessions and the ticket-ID mutex are in-process.

8. **Google Sheet.** Headers through column Y (`populate_sheet.js`). Cell `P1`
   is the ticket counter — never reset a live P1 to 0. Run
   `npm run sheet:status-dropdown`. Share the sheet Editor with the service
   account (`spreadsheets` scope only). Train staff on `docs/STAFF-SHEET.md`.

9. **Cloudinary** — confirm a real repair-photo upload. Tickets still create
   if upload fails; the sheet preview will be empty.

10. **Webhook URL** — Meta → WhatsApp → Configuration:
    `https://YOUR_HOST/webhook` (Railway hostname is enough; custom DNS optional).
    Subscribe to `messages`. Remove any ngrok URL.

11. **Owner 24h window.** Vedant, Vatsal, and any `BRANCH_OWNER_*` must send
    a message to the live number (and keep doing so) or free-form owner alerts
    fail with Meta 131047.

12. **Smoke test on the live number** (one pass, ~5 minutes) from a
    *non-owner* phone:
    language picker → menu (Repair / Track / Shop) → repair with photo →
    track the ticket → corporate → store locations → `terms` → `STOP`
    (opt_in_contacts column D = FALSE) → `RESUME`. Then staff-dropdown that
    ticket to *Bag Received* and *Ready for Pickup* during 10:00–19:00 IST
    and confirm the Utility template arrives (only if step 5 env is set).

### Emergency stop
If the bot ever starts misbehaving in production, set `OUTBOUND_KILL_SWITCH=1`
and restart — inbound is still processed, but no outbound message goes out until
you clear it.

## Already enforced by code

- Webhook HMAC (`X-Hub-Signature-256`, timing-safe); `SKIP_WEBHOOK_SIGNATURE`
  ignored in production; unsigned webhooks rejected.
- Production fail-fast: missing Meta, Google Sheets, or Cloudinary credentials abort startup with exit 1.
- Unapproved template names are **not** called: status/feedback jobs no-op
  until `REPAIR_UPDATE_TEMPLATE_*` / `FEEDBACK_TEMPLATE_*` are set.
- Per-IP rate limiting keyed on `req.ip` via `trust proxy`; JSON body capped at 100 KB.
- Message dedup, session timeouts, per-phone corporate-lead throttle.
- Ticket tracking is a shared-ID lookup (anyone with the exact ticket ID can view status; the reply has no customer name or phone) with a 5/hour cross-phone throttle.
- Sheets formula-injection defence (`safeUserText`) on all user-entered cells.
- Outbound image/document URLs restricted to an HTTPS host allowlist.
- `STOP` / `RESUME` opt-out honoured globally, even mid-flow; broadcasts only
  reach `opted_in = TRUE`.
- Media downloads capped (16 MB) and time-limited; Cloudinary uploads retried
  with timeout; broadcast queue rows claimed before sending (no double-blast).
- Phone numbers redacted to last-4 in all logs; control chars stripped.
- Security headers on every response; `X-Powered-By` disabled.
- `/ready` secret via `X-Readiness-Secret` header or query param.
- Ticket-counter reads fail loudly instead of silently resetting to 0.
- Outbound circuit breaker (`OUTBOUND_MAX_PER_MIN` / `OUTBOUND_MAX_PER_DAY`)
  plus `OUTBOUND_KILL_SWITCH`.
- Broadcast recipient cap (`BROADCAST_MAX_RECIPIENTS`, default 5000).
- Inbound messages get read receipts (blue ticks).
- Repair-photo Cloudinary IDs use a random token (no customer phone in the URL).

## Proactive notifications

WhatsApp only lets you send **free-form** messages within 24 hours of the
customer's last message. After that, business-initiated messages must be
**approved templates**. From **1 Oct 2026** Meta also bills in-window service
messages at the Utility rate.

Status pushes and feedback **only send as Utility templates**, and only when
the corresponding env vars are set. Quiet hours: 10:00–19:00 IST
(`PROACTIVE_START_HOUR` / `PROACTIVE_END_HOUR`).

Pickup reminders (`PICKUP_REMINDER_ENABLED`) stay off — they are still
free-form and will fail outside the 24h window.

Owner alerts (new ticket / lead / handoff / health) are always attempted as
free-form. They require the owner to have messaged the bot within 24h.

## Operational notes

- `/health` — liveness (no deps). `/ready` — checks Meta Graph credentials.
- Cron: status poll every 15 min, broadcasts hourly, pickup reminder default
  `30 4 * * *` (10:00 IST on UTC hosts), feedback hourly, health every 30 min.
  Server TZ on Railway is UTC unless you set `TZ=Asia/Kolkata`.
- Ticket counter lives in `repair_tickets!P1` — don't delete it.
- Single-process by design. Do not scale replicas without moving sessions
  and the ticket counter to a shared store.
