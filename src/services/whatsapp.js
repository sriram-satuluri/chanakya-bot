const axios = require('axios');
const { assertCanSend } = require('../utils/sendGuard');

const BASE_URL = `https://graph.facebook.com/v22.0`;

/** Strip BOM, quotes (common copy-paste from .env), and whitespace — wrong shape often still gives 401. */
function getMetaAccessToken() {
  let t = process.env.META_ACCESS_TOKEN;
  if (t == null) return '';
  t = String(t).replace(/^\ufeff/, '').trim();
  if (
    (t.startsWith('"') && t.endsWith('"'))
    || (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  return t.trim();
}

function headers() {
  const token = getMetaAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function phoneId() {
  return String(process.env.META_PHONE_NUMBER_ID || '').trim();
}

/**
 * Cheap sanity check for a recipient MSISDN (country-code digits, no +).
 * Used by proactive jobs to skip obviously-broken sheet cells (blank, "N/A",
 * a name typed into the phone column) before wasting a Graph API round-trip.
 * WhatsApp numbers are 8–15 digits including country code.
 */
function isLikelySendablePhone(v) {
  const digits = String(v ?? '').replace(/[^0-9]/g, '');
  return digits.length >= 8 && digits.length <= 15;
}

// ── Plain text ────────────────────────────────────────────────
async function sendTextMessage(to, text) {
  return call({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } });
}

// ── Interactive buttons (max 3) ───────────────────────────────
async function sendButtonMessage(to, bodyText, buttons) {
  // buttons: [{ id: 'btn_repair', title: '🔧 Repair My Bag' }, ...]
  return call({
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title.substring(0, 20) } })) },
    },
  });
}

// ── Interactive list (up to 10 items per section) ─────────────
async function sendListMessage(to, headerText, bodyText, buttonLabel, sections) {
  // sections: [{ title: 'Section Name', rows: [{ id, title, description? }] }]
  return call({
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: headerText },
      body: { text: bodyText },
      action: { button: buttonLabel, sections },
    },
  });
}

// ── Location ──────────────────────────────────────────────────
async function sendLocationMessage(to, lat, lng, name, address) {
  return call({ messaging_product: 'whatsapp', to, type: 'location', location: { latitude: lat, longitude: lng, name, address } });
}

// ── Image ─────────────────────────────────────────────────────
/**
 * Allowlist of hosts we will forward image URLs from. Anything else is refused
 * because a compromised sheet cell or a formula-injection payload could
 * otherwise coerce the bot into serving attacker-controlled URLs to customers
 * (phishing pixels, tracker images, arbitrary content branded as ours by Meta).
 *
 * Cloudinary is where the bot uploads to. Meta's own CDN is where Meta-hosted
 * media lives (unlikely for outbound but harmless to allow). Extend via
 * IMAGE_URL_ALLOWLIST=host1.com,host2.com in .env if you ever host photos
 * elsewhere.
 */
const _DEFAULT_IMAGE_HOSTS = new Set([
  // Cloudinary — where the bot uploads repair photos
  'res.cloudinary.com',
  'cloudinary.com',
  // GitHub raw — a cheap-and-cheerful host option for static docs like the T&Cs PDF
  'raw.githubusercontent.com',
  // WhatsApp / Meta CDN — for media returned by the Graph media API
  'scontent.whatsapp.net',
  // Google Drive — for the T&Cs PDF served via /uc?export=download&id=…
  // Only reachable if TERMS_DOC_URL points here; we already tested that Drive
  // returns raw PDF bytes for this endpoint. NB: /view URLs return HTML — those
  // are handled as text links (TERMS_URL), not attachments.
  'drive.google.com',
  'drive.usercontent.google.com',
]);
function _allowedImageHosts() {
  const extra = (process.env.IMAGE_URL_ALLOWLIST || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return new Set([..._DEFAULT_IMAGE_HOSTS, ...extra]);
}
function _isAllowedImageUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    const hosts = _allowedImageHosts();
    // Exact host match OR ".host" suffix match (e.g. sub.res.cloudinary.com)
    const h = url.hostname.toLowerCase();
    for (const allowed of hosts) {
      if (h === allowed || h.endsWith('.' + allowed)) return true;
    }
    return false;
  } catch { return false; }
}

async function sendImageMessage(to, imageUrl, caption = '') {
  if (!_isAllowedImageUrl(imageUrl)) {
    console.warn('[WA] Refusing to send image from non-allowlisted URL:', String(imageUrl).slice(0, 120));
    // Degrade to text so customer isn't left with nothing.
    return call({
      messaging_product: 'whatsapp', to, type: 'text',
      text: { body: caption ? String(caption) : 'A photo attachment was expected here but could not be shown.', preview_url: false },
    });
  }
  return call({ messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl, caption } });
}

// ── Document (PDF / DOCX / etc.) ─────────────────────────────
/**
 * Send a document (PDF preferred — WhatsApp renders inline; DOCX opens externally).
 * Uses the same allowlist as sendImageMessage so a compromised URL source can't
 * coerce the bot into forwarding attacker-controlled files to customers.
 */
async function sendDocumentMessage(to, docUrl, filename = 'document.pdf', caption = '') {
  if (!_isAllowedImageUrl(docUrl)) {
    console.warn('[WA] Refusing to send document from non-allowlisted URL:', String(docUrl).slice(0, 120));
    return call({
      messaging_product: 'whatsapp', to, type: 'text',
      text: { body: caption ? String(caption) : 'A document attachment was expected here but could not be shown.', preview_url: false },
    });
  }
  return call({
    messaging_product: 'whatsapp', to, type: 'document',
    document: { link: docUrl, filename: String(filename).slice(0, 240), caption: String(caption || '').slice(0, 1024) },
  });
}

/**
 * Sanitise a value destined for a template variable ({{1}}, {{2}}, …).
 *
 * Meta REJECTS a template send whose parameters contain newlines, tabs, or
 * 4+ consecutive spaces (error 132000 "parameter format does not match").
 * That matters here because these values are customer free-text that reached
 * us through the sheet — a customer whose name is "Ravi\nPatel", or a
 * staff-typed multi-line status cell, would otherwise fail EVERY send for
 * that ticket, tripping the consecutive-failure counter and silently
 * unsubscribing them from updates they asked for.
 *
 * Collapses all whitespace runs to a single space and trims.
 */
function sanitizeTemplateParam(value, maxLen = 200, fallback = '') {
  const s = String(value ?? '')
    .replace(/\s+/g, ' ')   // newlines, tabs, and multi-space runs → one space
    .trim();
  if (!s) return fallback;
  return s.length > maxLen ? s.slice(0, maxLen).trim() : s;
}

// ── Template message (for broadcasts / proactive alerts) ──────
async function sendTemplateMessage(to, templateName, langCode, components = []) {
  return call({
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name: templateName, language: { code: langCode }, components },
  });
}

// ── Mark as read ──────────────────────────────────────────────
async function markAsRead(messageId) {
  return call({ messaging_product: 'whatsapp', status: 'read', message_id: messageId });
}

// ── Download media from Meta ──────────────────────────────────
// Timeouts so a hung Graph call can't stall a customer's repair flow forever,
// and a size cap so an oversized media payload can't balloon process memory
// (WhatsApp images are ≤ ~5 MB; 16 MB gives generous headroom).
const MEDIA_MAX_BYTES = 16 * 1024 * 1024;
async function downloadMedia(mediaId) {
  // Step 1: get download URL
  const res = await axios.get(`${BASE_URL}/${mediaId}`, { headers: headers(), timeout: 15000 });
  const mediaUrl = res.data.url;
  // Step 2: download binary
  const imgRes = await axios.get(mediaUrl, {
    headers: headers(),
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: MEDIA_MAX_BYTES,
    maxBodyLength: MEDIA_MAX_BYTES,
  });
  return Buffer.from(imgRes.data);
}

/**
 * The parts of a Meta error that are safe to put in a log.
 *
 * Logging `err.response.data` wholesale used to be the exception to this
 * codebase's own redaction rule: Meta attaches an `error_data` block on some
 * failure codes whose `details` can echo the recipient's number back at us, so
 * a hosted log tail slowly accumulated exactly the full numbers that every
 * other log line is careful to cut to last-4.
 *
 * Everything actually needed to diagnose a failure — the numeric code, the
 * type, the human message and the trace id Meta support asks for — is kept.
 */
function summarizeMetaError(err) {
  const e = err.response?.data?.error;
  if (!e) return err.message;
  return {
    code: e.code,
    subcode: e.error_subcode,
    type: e.type,
    message: e.message,
    fbtrace_id: e.fbtrace_id,
  };
}

// ── Internal caller ───────────────────────────────────────────
async function call(payload) {
  const pid = phoneId();
  const token = getMetaAccessToken();
  if (!pid || !token) {
    const msg = '[WA] META_PHONE_NUMBER_ID or META_ACCESS_TOKEN is missing — cannot call Graph API';
    console.error(msg);
    throw new Error(msg);
  }

  const isReadReceipt = payload.status === 'read' && payload.message_id;
  if (!isReadReceipt && !payload.to) {
    console.error('[WA] Outbound payload missing `to`', { type: payload.type, keys: Object.keys(payload) });
    throw new Error('WhatsApp payload missing recipient');
  }

  // Circuit breaker: count real messages (not free read receipts). Throws if a
  // per-minute/per-day cap or the kill switch is hit — the caller's error
  // handling then drops this send instead of letting a runaway rack up cost /
  // trip Meta's spam detection.
  if (!isReadReceipt) assertCanSend();

  const url = `${BASE_URL}/${pid}/messages`;
  // Redact recipient to last-4 — hosted log tails must not accumulate full numbers.
  const toRedacted = payload.to ? '***' + String(payload.to).slice(-4) : '—';
  console.log(`[WA] -> POST ${url} (to=${toRedacted}, type=${payload.type ?? payload.status ?? '?'})`);
  try {
    const res = await axios.post(url, payload, { headers: headers(), timeout: 15000 });
    console.log(`[WA] <- ${res.status} OK wamid=${res.data?.messages?.[0]?.id || '?'}`);
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const metaErr = err.response?.data?.error || {};
    const code = metaErr.code;
    console.error('[WA] Send error:', status, summarizeMetaError(err));
    if (status === 401 || code === 190) {
      console.error(
        '[WA] ⚠ META_ACCESS_TOKEN rejected (401 / OAuth code 190). This is NEVER a webhook bug.',
        '\n       → Paste a NEW token into .env: Meta App → WhatsApp → API Setup (temporary), ',
        '\n         or Meta Business Suite → Settings → Business settings → Users → System users → ',
        '\n         add user → Assign assets → WhatsApp Accounts → Generate token (`whatsapp_business_messaging`).',
        '\n       → Restart the bot. Old tokens expire; regenerating rotates them.',
      );
    } else if (isOutsideWindowError(code)) {
      // 131047 = re-engagement required: >24h since the customer last messaged,
      // so a free-form send is rejected. This is EXPECTED for proactive pushes
      // (status poller, pickup reminders, reassurance, owner alerts). It is not a
      // bug — it means that notification must be sent as an approved *template*.
      // Surface it unmistakably so a missed notification is never silent.
      console.error(
        `[WA] ⚠ Message NOT delivered — 24-hour service window closed (Meta code ${code}). `
        + `Proactive/outbound-initiated messages to this recipient must use an APPROVED TEMPLATE `
        + `(sendTemplateMessage). Owner alerts also hit this if that person has not messaged the bot in 24h.`,
      );
    }
    throw err;
  }
}

/**
 * True for Meta errors that mean "you can't free-form message this user right
 * now" — chiefly 131047 (re-engagement / 24h window closed). Kept as a helper
 * so callers/jobs can branch on it without hard-coding magic numbers.
 */
function isOutsideWindowError(code) {
  return code === 131047 || code === 131051;
}

// ── Lightweight Graph check (no outbound message sent) ─────────
async function verifyMetaWhatsAppCredentials() {
  const pid = phoneId();
  const token = getMetaAccessToken();
  if (!pid || !token) {
    return { ok: false, reason: 'missing_env', hint: 'Set META_ACCESS_TOKEN and META_PHONE_NUMBER_ID in .env' };
  }
  try {
    const res = await axios.get(`${BASE_URL}/${pid}`, {
      params: { fields: 'display_phone_number,verified_name' },
      headers: headers(),
      timeout: 12000,
    });
    return {
      ok: true,
      phoneNumberId: pid,
      displayPhoneNumber: res.data.display_phone_number,
      verifiedName: res.data.verified_name || '',
    };
  } catch (err) {
    const status = err.response?.status;
    const metaErr = err.response?.data?.error || {};
    return {
      ok: false,
      phoneNumberId: pid,
      status,
      code: metaErr.code,
      type: metaErr.type,
      message: metaErr.message || String(err.message),
      fbtrace_id: metaErr.fbtrace_id,
      hint:
        status === 401 || metaErr.code === 190
          ? 'Generate a new WhatsApp Cloud API token (App → WhatsApp → API setup, or System user permanent token) and restart.'
          : 'Confirm Phone number ID belongs to this app and WhatsApp Business account.',
    };
  }
}

module.exports = {
  sendTextMessage, sendButtonMessage, sendListMessage,
  sendLocationMessage, sendImageMessage, sendDocumentMessage, sendTemplateMessage,
  markAsRead, downloadMedia,
  verifyMetaWhatsAppCredentials,
  getMetaAccessToken,
  phoneId,
  isLikelySendablePhone,
  isOutsideWindowError,
  sanitizeTemplateParam,
};
