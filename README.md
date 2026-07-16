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

### D. Railway (Hosting — $5/month when live)

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Then in Railway dashboard → Variables → Add all your .env values.

\---

## 📊 Google Sheets Headers

### Tab: repair\_tickets

```
ticket\_id | customer\_name | phone | bag\_type | problem | store | status | before\_photo\_url | after\_photo\_url | created\_at | updated\_at | estimated\_pickup | language | notes
```

Also add cell **P1** with value `0` — this is the ticket counter.

### Tab: product\_catalog

```
product\_id | category | brand | name | price\_range | in\_stock | description\_en | description\_hi | description\_gu | image\_url | store\_availability
```

### Tab: leads\_corporate

```
lead\_id | company\_name | contact\_name | phone | product\_type | quantity | budget | branding\_needed | contact\_time | created\_at | status | owner\_notes
```

### Tab: analytics\_log

```
timestamp | phone | language | intent | customer\_message | bot\_response\_summary | session\_id | escalated\_to\_human
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
phone | language | joined\_at | opted\_in
```

\---

## 🔄 How the Status Update System Works

1. Owner opens Google Sheets → `repair\_tickets` tab
2. Finds the customer's row by ticket ID
3. Changes value in column G (status) to one of:

   * `Bag Received`
   * `Inspection Done`
   * `Repair In Progress`
   * `Repair Complete`
   * `Ready for Pickup`
   * `Picked Up`
   * `Cannot Repair`
4. **Also updates column K (updated\_at)** to current datetime — this is what triggers the notification
5. Within 30 minutes, the cron job polls and sends the customer a WhatsApp update automatically

**For "Ready for Pickup"**: paste the after-photo Cloudinary URL in column I (after\_photo\_url) — the bot will send this image to the customer.

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
|Welcome|"hi"|Main menu with buttons|
|Hindi|"namaste"|Menu in Hindi|
|Gujarati|"kem cho"|Menu in Gujarati|
|Repair|Tap "Repair My Bag"|Starts repair flow|
|Photo|Send image in repair flow|Uploads to Cloudinary|
|Track|"TRACK CHA-2026-0001"|Shows ticket status|
|Store|Tap "Store Locations"|Two location pins|
|Corporate|Tap "Bulk / Corporate"|Lead capture flow|
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
│   └── ticketId.js       ← CHA-YYYY-NNNN generator
├── messages/
│   └── index.js          ← All message strings (3 languages)
└── jobs/
    ├── statusPoller.js   ← Checks for status changes every 30 min
    ├── broadcastRunner.js← Runs broadcast queue every hour
    └── pickupReminder.js ← 7-day uncollected bag reminders
```

\---

## 💰 Cost When Going Live

|Service|Cost|
|-|-|
|Railway Hobby|\~₹420/month|
|Meta API (customer-initiated chats)|₹0 FREE|
|Meta API (status update messages)|\~₹0.115/message|
|Cloudinary|₹0 (free tier)|
|Google Sheets|₹0 (free)|
|**Total (typical small volume)**|**\~₹600–900/month**|

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

* Make sure column K (updated\_at) is updated when you change status
* Cron runs every 30 minutes — max 30 min delay

