# 🎒 Chanakya – The Bag Studio | WhatsApp Chatbot

Full-stack WhatsApp chatbot for Chanakya Bag Studio, Vadodara.
Trilingual (English / Hindi / Gujarati), repair ticketing, Google Sheets backend, broadcast marketing.

\---

## ⚡ Quick Start (Testing — Free, No Subscriptions Needed)

### Step 1 — Install dependencies

```bash
npm install
```

### Step 2 — Create your .env file

```bash
cp .env.example .env
```

Then fill in the values (see Setup Guide below).

### Step 3 — Start the server

```bash
npm run dev
```

### Step 4 — Expose locally using ngrok (for testing)

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3000
# Copy the https URL — e.g. https://abc123.ngrok.io
```

### Step 5 — Set webhook in Meta

Go to: developers.facebook.com → Your App → WhatsApp → Configuration

* Webhook URL: `https://abc123.ngrok.io/webhook`
* Verify Token: same as WEBHOOK\_VERIFY\_TOKEN in your .env

\---

## 📋 Full Setup Guide

### A. Meta / WhatsApp API (Free)

1. Go to https://developers.facebook.com → Create App → Business type
2. Add "WhatsApp" product
3. In WhatsApp → Getting Started:

   * Note your **Phone Number ID**
   * Note your **Temporary Access Token** (valid 24h for testing)
4. For permanent token:

   * Meta Business Settings → Users → System Users → Create
   * Assign "WhatsApp Business Account" asset → generate token
5. Note your **App Secret** (App Settings → Basic)
6. In WhatsApp → Configuration:

   * Set Webhook URL → your Railway or ngrok URL + `/webhook`
   * Set Verify Token → same as WEBHOOK\_VERIFY\_TOKEN in .env
   * Subscribe to: `messages` field

### B. Google Sheets (Free)

1. Create a new Google Spreadsheet
2. Create these 7 tabs (exact names matter!):

   * `repair\_tickets`
   * `product\_catalog`
   * `leads\_corporate`
   * `analytics\_log`
   * `broadcast\_log`
   * `broadcast\_queue`
   * `opt\_in\_contacts`
3. Add header rows (see Headers section below)
4. Go to https://console.cloud.google.com
5. Create a project → Enable **Google Sheets API**
6. IAM \& Admin → Service Accounts → Create
7. Download JSON key
8. Copy `client\_email` → GOOGLE\_SERVICE\_ACCOUNT\_EMAIL in .env
9. Copy `private\_key` → GOOGLE\_PRIVATE\_KEY in .env
10. **Share your Spreadsheet** with the service account email (Editor role)
11. Copy Spreadsheet ID from URL → GOOGLE\_SHEETS\_ID in .env

    * URL format: `https://docs.google.com/spreadsheets/d/SHEET\_ID\_HERE/edit`

### C. Cloudinary (Free Tier — Permanent)

1. Sign up at https://cloudinary.com (free forever)
2. Dashboard → Copy Cloud Name, API Key, API Secret → .env

### D. Railway (Hosting — ~$5/month Hobby when live)

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Then in Railway dashboard:

* Variables → add all production `.env` values (`NODE_ENV=production`, secrets, template names once Meta approves them).
* Attach a **volume** at `/data` and set `SESSION_CACHE_PATH`, `DEDUP_CACHE_PATH`, `THROTTLE_CACHE_PATH`, `HEALTH_CACHE_PATH` to files on that volume.
* One replica only. Point Meta's webhook at `https://YOUR_SERVICE.up.railway.app/webhook`.

See `LAUNCH_CHECKLIST.md` for the full cutover.

\---

## 📊 Google Sheets Headers

### Tab: repair\_tickets (columns A–Y)

```
ticket_id | customer_name | phone | bag_type | problem | store | status | before_photo_url | after_photo_url | created_at | updated_at | estimated_pickup | language | notes | last_reassurance_at | (P reserved — counter in P1) | opted_in | last_status_sent | last_update_sent_at | stop_reason | consecutive_failure_count | picked_up_seen_at | feedback_requested_at | rating | rating_at
```

Cell **P1** is the ticket counter. Initialise to `0` only when empty — never reset a live sheet. Columns Q–Y are written by the bot. Easiest: `node populate_sheet.js` then `npm run sheet:status-dropdown`.

### Tab: product\_catalog

Sheet tab still exists (headers below) for completeness. **The Shop flow does not read it** — it deep-links to the live website (`front.chanakyacorporate.com`).

```
product_id | category | brand | name | price_range | in_stock | description_en | description_hi | description_gu | image_url | store_availability
```

### Tab: leads\_corporate

```
lead\_id | company\_name | contact\_name | phone | product\_type | quantity | budget | branding\_needed | contact\_time | created\_at | status | owner\_notes
```

### Tab: analytics\_log

```
timestamp | phone | language | intent | customer_message | bot_response_summary | session_id | escalated_to_human | flow_name | flow_step
```

### Tab: broadcast\_log

```
broadcast\_id | template\_name | sent\_at | recipients | delivered | replies\_received
```

### Tab: broadcast\_queue

```
campaign\_name | template\_name | send\_at | audience\_filter | language | variables\_json | status
```

Add a row with `status = pending` and `send\_at` set to a future datetime to trigger a broadcast.

### Tab: opt\_in\_contacts

```
phone | language | joined_at | opted_in | name
```

\---

## 🔄 How the Status Update System Works

1. Owner opens Google Sheets → `repair\_tickets` tab
2. Finds the customer's row by ticket ID
3. Changes column **G** (status) using the **dropdown only**:

   * `Bag Received`
   * `Inspection Done`
   * `Repair In Progress`
   * `Repair Complete`
   * `Ready for Pickup`
   * `Picked Up`
   * `Cannot Repair`
4. Within **15 minutes** (during 10:00–19:00 IST), if the customer opted in **and** `REPAIR_UPDATE_TEMPLATE_*` is set to approved Meta names, they get a WhatsApp Utility template. Otherwise they can still *Track My Repair* for free.

**Do not type a custom status.** Use the column G dropdown (`npm run sheet:status-dropdown`). After-photos (column I) are for staff; they are not auto-sent as a WhatsApp image.

\---

## 📢 How to Send a Marketing Broadcast

1. Open Google Sheets → `broadcast\_queue` tab
2. Add a new row:

```
   campaign\_name: Diwali Offer 2026
   template\_name: festival\_offer    ← must match approved Meta template name
   send\_at: 2026-10-20 09:00
   audience\_filter: all
   language: hindi
   variables\_json: {"1":"50% OFF on all Trolley Bags!","2":"Valid till 25 Oct"}
   status: pending
   ```

3. The bot's hourly cron job will send it at the specified time

**Note**: Template messages must be approved by Meta first (24-48 hours). Submit via Meta Business Manager → WhatsApp → Message Templates.

\---

## 🧪 Testing the Bot

After setup, test these flows on WhatsApp:

|Test|What to send|Expected result|
|-|-|-|
|Welcome|"hi"|Language picker (first time), then main menu|
|Shop|Tap "Shop"|Category list → website link|
|Repair|Tap "Repair My Bag"|Starts repair flow|
|Photo|Send image after the ticket exists|Uploads to Cloudinary|
|Track|"TRACK CHA-R-2026-0001"|Shows ticket status|
|Store|Tap "Store Locations"|Two location pins|
|Corporate|Tap "Bulk / Corporate"|Lead capture flow|
|Language|Type "language"|Picker again|
|Fallback|Send "asdfghjkl" 3x|Offers human contact|

\---

## 🏗️ Project Structure

```
src/
├── index.js              ← Entry point, Express server, cron jobs
├── webhook/
│   ├── verify.js         ← Meta webhook handshake
│   └── handler.js        ← Routes all incoming messages
├── flows/
│   ├── mainMenu.js       ← Welcome + main menu
│   ├── repair.js         ← Repair booking (most important)
│   ├── track.js          ← Repair status tracking
│   ├── catalog.js        ← Product browsing
│   ├── storeLocations.js ← Store map pins
│   ├── corporate.js      ← Bulk order lead capture
│   └── escalate.js       ← Human handoff + fallback
├── services/
│   ├── whatsapp.js       ← All Meta API calls
│   ├── sheets.js         ← All Google Sheets operations
│   └── cloudinary.js     ← Image upload
├── utils/
│   ├── sessionStore.js   ← In-memory session management
│   ├── languageDetect.js ← English / Hindi / Gujarati detection
│   ├── intentDetect.js   ← Maps messages to intents
│   └── ticketId.js       ← CHA-R/S-YYYY-NNNN generator
├── messages/
│   └── index.js          ← All message strings (3 languages)
└── jobs/
    ├── statusPoller.js   ← Status Utility templates every 15 min (column G)
    ├── broadcastRunner.js← Runs broadcast queue every hour
    ├── pickupReminder.js ← 7-day uncollected bag reminders (off by default)
    ├── feedbackRequest.js← Post-pickup rating templates
    └── healthCheck.js    ← Meta + Sheets probe; persists to data/
```

\---

## 💰 Cost When Going Live

|Service|Cost|
|-|-|
|Railway Hobby|\~₹420–670/month (volume + always-on RAM; $5 credit)|
|Meta (until 30 Sep 2026, customer-initiated chats)|₹0|
|Meta Utility templates (status / feedback, out of window)|\~₹0.115/message|
|Meta Marketing templates|\~₹0.8631/message|
|Meta (from 1 Oct 2026, every outbound service message)|Utility rate — confirm card 1 Sep 2026|
|Cloudinary|₹0 (free tier, 25 credits/mo)|
|Google Sheets|₹0 (free; 60 writes/min/user)|
|**Typical small volume before 1 Oct**|**\~₹450–900/month**|

\---

## 👥 Owners \& Contact

* **Vedant Joshi** — +91 99745 92477
* **Vatsal Joshi** — +91 99740 17725

\---

## 🆘 Troubleshooting

**Bot not responding?**

* Check Railway logs: `railway logs`
* Verify webhook is verified in Meta dashboard (green tick)
* Ensure .env has correct META\_PHONE\_NUMBER\_ID and META\_ACCESS\_TOKEN

**Google Sheets not updating?**

* Verify service account email has Editor access to the sheet
* Check GOOGLE\_PRIVATE\_KEY has actual `\\n` newlines, not escaped `\\\\n`

**Photos not uploading?**

* Check Cloudinary credentials in .env
* Bot continues even if photo upload fails — ticket is still created

**Status updates not sending?**

* Customer must have tapped "Yes, update me" after booking
* `REPAIR_UPDATE_TEMPLATE_EN/HI/GU` must be set to **approved** Meta template names
* Quiet hours are 10:00–19:00 IST; cron polls every 15 minutes on column G
* Staff must use the column G dropdown, not free-typed wording

