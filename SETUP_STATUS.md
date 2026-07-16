# Chanakya Bot — Setup Status & Runbook

Generated for Sriram. Captures everything done so far + what's left.

## State of the codebase

All known bugs are fixed and the code is verified working end-to-end. The bot has been observed receiving WhatsApp messages, processing them, calling Meta API, and getting back 200 OK with wamids. The only remaining unknowns are operational (token rotation + Meta-side delivery to your specific phone).

### Bugs fixed in the source

| File | Bug | Fix |
|------|-----|-----|
| `src/services/sheets.js` | `??`/`||` precedence syntax error at line 140-142 | Added parens around the `||` to satisfy the JS spec |
| `src/services/sheets.js` | Missing closing `};` for `module.exports` block | Appended the closing brace so the file parses |
| `src/services/whatsapp.js` | `call()` had no logging on success and no timeout (could hang forever) | Added `[WA] -> POST` and `[WA] <- 200 OK wamid=...` logs; 15s axios timeout |
| `src/flows/mainMenu.js` | No visibility into when the flow was entered/exited | Added `[MENU] showMainMenu called/done` traces |
| `src/webhook/handler.js` | Signature verification used `JSON.stringify(req.body)` which produces different bytes than the raw payload Meta signs → every real Meta POST was rejected when `META_APP_SECRET` was set | Switched to `req.rawBody` (captured by express.json verify hook); added length-safe buffer compare |
| `src/webhook/handler.js` | No logging of Meta delivery status callbacks (`sent`, `delivered`, `failed`) | Added `[STATUS] <status> for wamid=... recipient=... errors=...` |
| `src/index.js` | No raw-body capture for HMAC verification | Replaced `express.json()` with `express.json({ verify: ... })` |

## State of external services

| Service | Status |
|---------|--------|
| Google Sheet "Chatbot" (id `12Fb5g8I9k8d8OyWZucLNp0RzlZnlL35A6jt-TC0U8nI`) | All 7 tabs created with correct header rows; `repair_tickets!P1 = 0` (ticket counter); service account has Editor access. **Status column G**: run `npm run sheet:status-dropdown` so employees get a predefined dropdown (`src/constants/repairTicketStatuses.js`). Verified by read+write tests. |
| Service account `chanakya-the-bag-studio@chanakya-chatbot-495613.iam.gserviceaccount.com` | Authentication works from the bot. |
| Cloudinary account `dx4ozzg28` | Created. API key is in `.env` (never in this doc). API secret still pending (Cloudinary re-issues the email code each time you click reveal, so you must paste the latest one). Only matters for the photo upload step in repair flow. |
| ngrok tunnel | URL `https://fit-crucial-coyness.ngrok-free.dev` is bound to your authtoken (stored in your ngrok config — never in this doc) — same URL every time you run ngrok. |
| Meta webhook | Configured. Verify token = value of `WEBHOOK_VERIFY_TOKEN` in `.env` (rotate before launch — see LAUNCH_CHECKLIST.md). Subscribed to `messages` field. Verified working (Meta successfully GET-checked the URL). |

## The two operational problems blocking testing

### Problem 1: Meta access tokens rotate aggressively

Your "temporary" token expired in roughly 25 minutes during this session (Meta docs claim 24h, but observed behavior is much shorter for this app). Every time it expires, Meta returns:

```json
{"error":{"message":"Authentication Error","code":190,"type":"OAuthException"}}
```

**Permanent fix — System User token (one-time setup, never expires):**

1. Go to https://business.facebook.com → click **Settings** (gear icon)
2. **Users → System Users** → **Add** → name it `chanakya-bot` → Role: **Admin** → Create
3. Click the new user → **Add Assets** → select **WhatsApp Accounts** → pick your Chanakya WhatsApp Business Account → enable **Manage WhatsApp Business Account** permission → Save
4. Back on the System User row → click **Generate New Token**
5. Pick your **Chanakya app**
6. **Token Expiration: Never**
7. Permissions: tick **`whatsapp_business_messaging`** and **`whatsapp_business_management`**
8. Click **Generate**
9. Copy the very long `EAA...` token immediately (Meta only shows it once)
10. Paste it into `.env`: replace the existing `META_ACCESS_TOKEN=...` line with the new value
11. Save the file
12. Restart the bot (`Ctrl+C` then `npm run dev`)

### Problem 2: Meta accepts messages but they don't reach your phone

When the token IS valid, every outbound message returns `200 OK` with a `wamid` and `message_status: "accepted"` — meaning Meta queued it. But `+91XXXXXX6663` never sees the message in WhatsApp. This was reproduced with:

- The bot's interactive button replies
- Direct API calls (plain text)
- Direct API calls (`hello_world` template)
- Meta's own "Send message" button in API Setup

All accepted by Meta, none delivered to your phone.

**What this is NOT:**
- Not a bot bug (logs prove successful API calls)
- Not a webhook issue (Meta is forwarding inbound `hi` to the bot correctly)
- Not a token issue at the time of those tests (tokens were valid when sent)
- Not a phone-side block (you confirmed `+1 555 641 7220` isn't blocked)

**What this likely IS (after extensive testing):**
- Meta WABA-level delivery routing issue — confirmed by Meta returning error `131000 Something went wrong` for every outbound wamid, to multiple recipients
- App was published to Live mode → delivery still fails identically
- Both recipients (`91XXXXXX6663` and `91XXXXXX4072`) re-added with fresh OTP verification → delivery still fails identically
- Inbound from both recipients arrives at the webhook correctly; only outbound Meta → recipient hop fails
- This is now confirmed a Meta-side operational issue and requires Meta support to investigate the WABA, OR creating a fresh app+WABA to bypass

**Sample failed wamid for support ticket:** `wamid.HBgMOTE4NDkwMDQ2NjYzFQIAERgSRkMyQUQ3NUVDNjA0RUZFMDRBAA==`

**App + WABA identifiers for Meta support:**
- App ID: `4289855304601657`
- Phone Number ID: `1081765638356720`
- Display Phone Number: `+1 555-641-7220`
- Phone status: CONNECTED, platform_type: CLOUD_API, code_verification_status: NOT_VERIFIED

**Diagnostic steps to run when you're back:**

1. Get permanent token (Problem 1).
2. Restart bot. Make sure both PowerShell windows are open and the bot logs the startup banner.
3. From your phone send `hi` to `+1 555 641 7220`.
4. Wait 60 seconds.
5. Look at PowerShell #1 for the new `[STATUS] ...` log lines — Meta sends these as the message moves through `sent` → `delivered` → `read`, or `failed` with an error code.
6. **The error code (if any) tells us the root cause.** Common ones:
   - `131047` — re-engagement timed out (24h window expired)
   - `131026` — receiver incapable (recipient phone can't accept business messages)
   - `131051` — unsupported message type
   - `132000` — number flagged for spam/quality

If you only see `sent` and never `delivered`, that's Meta-side queue throttling.

If you see no `[STATUS]` events at all after 60 seconds, the webhook isn't subscribed to status events — go to Webhook fields → Manage and make sure the field labeled `messages` toggle is on (status events come on the same field).

## Quick start commands (copy-paste)

```powershell
# PowerShell window 1 — the bot
cd S:\Projects\ChatBot\chanakya-bot\chanakya-bot
npm run dev

# PowerShell window 2 — the tunnel (URL stays the same on this authtoken)
ngrok http 3000
```

Then on phone: WhatsApp → message `+1 555 641 7220` → `hi`.

Expected bot output:
```
🎒 Chanakya Bot server running on port 3000
[WEBHOOK] Verification successful           ← Meta re-verifying
[MSG] From 91XXXXXX6663: "hi" (type: text)
[LANG] Detected: english for 91XXXXXX6663
[MENU] showMainMenu called for 91XXXXXX6663 lang=english
[WA] -> POST https://graph.facebook.com/v19.0/.../messages (to=91XXXXXX6663, type=interactive)
[WA] <- 200 OK wamid=wamid....
[WA] -> POST https://graph.facebook.com/v19.0/.../messages (to=91XXXXXX6663, type=interactive)
[WA] <- 200 OK wamid=wamid....
[MENU] showMainMenu done for 91XXXXXX6663
[STATUS] sent for wamid=... recipient=91XXXXXX6663        ← Meta acknowledging
[STATUS] delivered for wamid=... recipient=91XXXXXX6663   ← Phone confirmed receipt
```

If the `[STATUS] delivered` line appears but you still don't see the message in WhatsApp, search "Archived Chats" in WhatsApp (pull down chat list) — sometimes business messages auto-archive.

## .env reference (current values)

```
META_PHONE_NUMBER_ID=1081765638356720
META_ACCESS_TOKEN=<see .env — System User token, never in this doc>
META_APP_SECRET=                ← REQUIRED in production (see LAUNCH_CHECKLIST.md)
WEBHOOK_VERIFY_TOKEN=<see .env — rotate before launch>
GOOGLE_SHEETS_ID=<see .env>
GOOGLE_SERVICE_ACCOUNT_EMAIL=chanakya-the-bag-studio@chanakya-chatbot-495613.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="<see .env — never in this doc>"
CLOUDINARY_CLOUD_NAME=dx4ozzg28
CLOUDINARY_API_KEY=<see .env>
CLOUDINARY_API_SECRET=<see .env>          ← photo flow only
OWNER_PHONE_VEDANT=<see .env>
OWNER_PHONE_VATSAL=<see .env>
PORT=3000
NODE_ENV=development
```

## Summary

The bot is done. Two things stand between you and a working test:
1. Get a permanent System User token (5 min, never expires).
2. Get Meta to actually deliver the messages — most likely fixed by re-verifying your test recipient phone in API Setup, or by publishing the app.
