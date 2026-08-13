const crypto = require('crypto');
const { getSession, updateSession } = require('../utils/sessionStore');
const { detectLanguage } = require('../utils/languageDetect');
const { detectIntent } = require('../utils/intentDetect');
const { logAnalytics, setCustomerLanguage, hasOpenOptedInTicket } = require('../services/sheets');
const { markAsRead } = require('../services/whatsapp');
const { claimMessage } = require('../utils/dedupStore');
const { resolveLanguage, setCachedLanguage } = require('../utils/languagePref');

/* ── Log-safety helpers ──────────────────────────────────────────────
 * PII redaction + log-injection defence. Phones are truncated to last-4
 * so logs still let you correlate a session without persisting a full
 * WhatsApp number. Free-text is stripped of newlines and ANSI/control
 * chars so a customer can't forge fake "admin" log lines by including
 * \n in their message. Length capped for the same reason.
 */
function redactPhone(p) {
  const s = String(p || '');
  if (s.length <= 4) return '***';
  return '***' + s.slice(-4);
}
function sanitizeForLog(s, maxLen = 140) {
  if (s == null) return '';
  let out = String(s);
  if (out.length > maxLen) out = out.slice(0, maxLen) + '…';
  // Strip C0/C1 control chars + ANSI escape sequences so a customer message can't
  // inject fake log lines. Printable UTF-8 (Devanagari, Gujarati, emoji) untouched.
  out = out
    .replace(/\x1b\[[0-9;?]*[\x20-\x2f]*[\x40-\x7e]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ');
  return out;
}

// Flow handlers
const { showMainMenu } = require('../flows/mainMenu');
const { handleRepairFlow } = require('../flows/repair');
const { handleTrackFlow } = require('../flows/track');
const { handleCatalogFlow } = require('../flows/catalog');
const { handleStoreLocations } = require('../flows/storeLocations');
const { handleCorporateFlow } = require('../flows/corporate');
const { handleEscalation, handleFallback } = require('../flows/escalate');
const { handleTermsRequest } = require('../flows/terms');
const { sendLanguagePicker, handleLanguageChoice } = require('../flows/language');
const {
  handleRepairUpdatesAnswer, handleRepairUpdatesCommand,
} = require('../flows/repairUpdates');

// Message de-duplication lives in utils/dedupStore.js — it is disk-backed so
// that a restart during Meta's retry window cannot re-process a message and
// create a duplicate repair ticket.

async function handleWebhook(req, res) {
  // Always respond 200 immediately — Meta will retry if you don't
  res.sendStatus(200);

  try {
    // Verify signature
    if (!verifySignature(req)) {
      const hasSecret = Boolean(process.env.META_APP_SECRET?.trim());
      console.warn('[WEBHOOK] Invalid signature — ignoring', {
        hasSecret,
        hasSigHeader: Boolean(req.headers['x-hub-signature-256']),
        hasRawBody: Boolean(req.rawBody),
      });
      return;
    }

    const body = req.body;
    console.log('[WEBHOOK] inbound object=%s entries=%s', body?.object, body?.entry?.length ?? 0);
    if (body?.object !== 'whatsapp_business_account') {
      if (body?.object) console.warn('[WEBHOOK] Ignoring payload object=%s (expected whatsapp_business_account)', body.object);
      return;
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        // Log status events (sent / delivered / read / failed) for diagnostics
        if (value.statuses) {
          for (const s of value.statuses) {
            console.log(`[STATUS] ${s.status} for wamid=${s.id} recipient=${redactPhone(s.recipient_id)}` +
              (s.errors ? ` errors=${sanitizeForLog(JSON.stringify(s.errors), 200)}` : ''));
          }
        }
        if (!value.messages) continue;

        for (const message of value.messages) {
          // Skip duplicates. Backed by disk (utils/dedupStore.js) so a restart
          // inside Meta's retry window can't re-process a message and create a
          // second repair ticket for the same request.
          if (!claimMessage(message.id)) {
            console.log(`[DEDUP] Skipping already-processed message ${message.id}`);
            continue;
          }

          await processMessage(message, value.contacts?.[0]);
        }
      }
    }
  } catch (err) {
    console.error('[WEBHOOK] Error processing:', err.message);
  }
}

async function processMessage(message, contact) {
  const phone = message.from;
  if (!phone) {
    console.warn('[WEBHOOK] Skipping message with no from id', message?.id);
    return;
  }
  const msgType = message.type;

  // Send a read receipt (blue ticks) so the customer sees the business is
  // responsive. Free, not billed, not counted by the circuit breaker.
  // Fire-and-forget — must never block or break message handling.
  if (message.id) markAsRead(message.id).catch(() => {});

  // Extract text content
  let text = '';
  if (msgType === 'text') {
    text = message.text?.body?.trim() || '';
  } else if (msgType === 'interactive') {
    // Prefer stable row/button ids; some clients omit id — fall back to list title text.
    const lr = message.interactive?.list_reply;
    text = message.interactive?.button_reply?.id ||
           lr?.id ||
           (lr?.title?.trim() || '');
  } else if (msgType === 'button') {
    // Legacy quick-reply / button payload (some clients still send this)
    text = (message.button?.payload || message.button?.text || '').trim();
  } else if (
    msgType === 'image'
    || (msgType === 'document'
      && String(message.document?.mime_type || '').toLowerCase().startsWith('image/'))
  ) {
    text = '__IMAGE__';
  }

  // Global input-length cap. Meta's own text.body limit is 4096, but nothing
  // in our flows benefits from more than a few hundred chars. Cap early so
  // a huge payload can't blow up downstream storage, logging, or Sheets writes.
  if (text.length > 1000) text = text.slice(0, 1000);

  console.log(`[MSG] From ${redactPhone(phone)}: "${sanitizeForLog(text)}" (type: ${msgType})`);

  // Get or create session
  let session = getSession(phone);

  // Resolve language: in-memory session → stored preference (Sheets) →
  // auto-detect as a last resort. The stored preference is what makes the
  // choice survive restarts, so a returning customer is never re-asked.
  if (!session.language) {
    const stored = await resolveLanguage(phone).catch(() => null);
    if (stored) {
      session.language = stored;
      updateSession(phone, { language: stored });
      console.log(`[LANG] Restored stored preference ${stored} for ${redactPhone(phone)}`);
    } else {
      // Never picked a language → provisional detection just so the picker and
      // any error text render sensibly; the picker itself decides the real one.
      session.language = detectLanguage(text);
      updateSession(phone, { language: session.language, needsLanguagePick: true });
      session.needsLanguagePick = true;
      console.log(`[LANG] First contact ${redactPhone(phone)} — provisional ${session.language}, will ask`);
    }
  }

  // Language override keywords. When user explicitly switches language,
  // reset the greeting flag so the next main menu greets them fresh in the new language.
  const langOverride = checkLanguageOverride(text);
  if (langOverride && langOverride !== session.language) {
    updateSession(phone, { language: langOverride, greeted: false, needsLanguagePick: false });
    session.language = langOverride;
    session.greeted = false;
    session.needsLanguagePick = false;
    setCachedLanguage(phone, langOverride);
    // Persist so the switch outlives this session (fire-and-forget: the
    // customer is already being served in the new language either way).
    setCustomerLanguage(phone, langOverride).catch((e) =>
      console.error(`[LANG] Failed to persist override for ${redactPhone(phone)}:`, e.message));
    console.log(`[LANG] ${redactPhone(phone)} switched language: -> ${langOverride}`);
  }

  // Update last activity time
  updateSession(phone, { lastActivity: Date.now() });

  // Detect intent
  const intent = detectIntent(text, session);

  // Log to analytics (fire and forget)
  logAnalytics({
    phone,
    language: session.language,
    intent,
    customerMessage: text,
    sessionId: `sess_${phone}`,
  }).catch(() => {}); // Don't block on analytics failure

  // Route to correct flow
  try {
    await routeMessage({ phone, text, msgType, message, session, intent });
  } catch (err) {
    console.error('[MSG] routeMessage failed:', err.message);
    if (err.response?.data) console.error('[MSG] downstream:', sanitizeForLog(JSON.stringify(err.response.data), 400));
    console.error(err.stack);
  }
}

// Top-level main-menu button IDs. Tapping ANY of these always switches
// context, even mid-flow — so a user can back out of one flow and into
// another just by tapping a different button.
const FLOW_TRIGGER_BUTTONS = new Set([
  'btn_repair', 'btn_shop', 'btn_track', 'btn_corporate', 'btn_location', 'btn_human', 'btn_terms',
  'flow_repair', 'flow_track', 'flow_catalog', 'flow_corporate', 'flow_terms',
]);

async function routeMessage({ phone, text, msgType, message, session, intent }) {
  // ── Language selection ──────────────────────────────────────────────
  // Answering the picker always wins, wherever the customer is.
  if (intent === 'language_choice') {
    const chosen = await handleLanguageChoice(phone, text);
    if (chosen) {
      session.language = chosen;
      session.needsLanguagePick = false;
      return showMainMenu(phone, chosen);
    }
  }

  // Explicit request to change language, at any point in the conversation.
  if (intent === 'change_language') {
    return sendLanguagePicker(phone, session.language);
  }

  // First-ever contact: ask for a language before anything else, so the whole
  // conversation (including the main menu) is in their language from message one.
  if (session.needsLanguagePick) {
    return sendLanguagePicker(phone, session.language);
  }

  // Standing repair-update commands ("stop updates" / "resume updates").
  // Deliberately separate from marketing STOP/RESUME below, and honoured
  // mid-flow without disturbing flow state.
  if (intent === 'repair_updates_off' || intent === 'repair_updates_on') {
    return handleRepairUpdatesCommand(phone, session.language, intent === 'repair_updates_on');
  }

  // Explicit "go to main menu" always resets and shows the menu — escape hatch.
  // Also resets the fallback counter so a returning user doesn't get insta-escalated
  // after previously hitting 3 fallbacks.
  if (intent === 'main_menu') {
    updateSession(phone, { currentFlow: null, flowStep: null, collectedData: {}, fallbackCount: 0 });
    return showMainMenu(phone, session.language);
  }

  // Broadcast opt-out / opt-in are global commands (exact "STOP"/"RESUME") and
  // must be honoured even mid-flow — WhatsApp policy. Flow state is preserved.
  if (intent === 'opt_out' || intent === 'opt_in') {
    const optIn = intent === 'opt_in';
    const { setContactOptIn } = require('../services/sheets');
    const { sendTextMessage } = require('../services/whatsapp');
    const M = require('../messages/index');
    try {
      await setContactOptIn(phone, optIn, session.language);
    } catch (e) {
      // Don't falsely confirm a compliance action that didn't persist.
      console.error(`[OPT] Failed to persist ${intent} for ${redactPhone(phone)}:`, e.message);
      return sendTextMessage(phone,
        'Sorry, we could not update your message preferences right now. Please send this again in a few minutes.');
    }
    console.log(`[OPT] ${intent} recorded for ${redactPhone(phone)}`);
    let confirm = M.get(optIn ? 'opt_in_confirmed' : 'opt_out_confirmed', session.language);
    // Bare STOP only stops MARKETING. If they still have an open, opted-in
    // repair ticket, say so plainly rather than letting them assume everything
    // has stopped — and tell them the phrase that does stop those too.
    if (!optIn) {
      const stillOn = await hasOpenOptedInTicket(phone).catch(() => false);
      if (stillOn) confirm += M.get('opt_out_repair_still_on', session.language);
    }
    return sendTextMessage(phone, confirm);
  }

  // Escalation-paused sessions were a UX dead-end: user tapped "Talk to Team", session
  // paused for 2h, and any subsequent message was silently ignored. Now, if a paused
  // customer sends ANY message — button tap or free text — we auto-resume: clear the
  // paused flow so the intent switch below can route normally.
  if (session.currentFlow === 'paused') {
    console.log(`[ROUTE] Auto-resuming paused session for ${redactPhone(phone)} (msg="${sanitizeForLog(text, 40)}")`);
    updateSession(phone, { currentFlow: null, flowStep: null, collectedData: {}, fallbackCount: 0 });
    session.currentFlow = null;
    session.flowStep = null;
    session.collectedData = {};
    session.fallbackCount = 0;
  }

  // Tapping a main-menu trigger button mid-flow = user wants to switch context.
  // Abandon the current flow's state and fall through to intent-based routing.
  if (FLOW_TRIGGER_BUTTONS.has(text) && session.currentFlow && session.currentFlow !== 'paused') {
    console.log(`[ROUTE] Flow switch: ${session.currentFlow} -> ${text} (user tapped a main-menu button mid-flow)`);
    updateSession(phone, { currentFlow: null, flowStep: null, collectedData: {} });
    session.currentFlow = null;
    session.flowStep = null;
    session.collectedData = {};
  }

  // If a flow is active, it OWNS the message (list row ids bag_* / prob_* / cat_*,
  // typed answers like "Zip / Chain Issue", images). Run it BEFORE escalate/fallback,
  // otherwise verbs like escalate's old "issue" keyword hijack repairs.
  if (session.currentFlow && session.currentFlow !== 'paused') {
    switch (session.currentFlow) {
      case 'repair':    return handleRepairFlow(phone, text, msgType, message, session, intent);
      case 'track':     return handleTrackFlow(phone, text, session, intent);
      case 'catalog':   return handleCatalogFlow(phone, text, session, intent);
      case 'corporate': return handleCorporateFlow(phone, text, session, intent);
      case 'store_location':
        return handleStoreLocations(phone, text, session, intent);
      case 'repair_updates':
        return handleRepairUpdatesAnswer(phone, text, session);
      case 'language':
        // Sitting on the picker but sent something else — re-show it rather
        // than dropping them into an unrelated flow.
        return sendLanguagePicker(phone, session.language);
    }
  }

  // Explicit "talk to support" once no transactional flow consumed the message.
  if (intent === 'escalate') {
    return handleEscalation(phone, session.language, text);
  }

  // T&Cs is one-shot — never holds session state. Route before fallback.
  if (intent === 'terms') {
    return handleTermsRequest(phone, session.language);
  }

  // No active flow — route by intent.
  switch (intent) {
    case 'repair':         return handleRepairFlow(phone, text, msgType, message, session, intent);
    case 'track_repair':   return handleTrackFlow(phone, text, session, intent);
    case 'shop_catalog':   return handleCatalogFlow(phone, text, session, intent);
    case 'store_location': return handleStoreLocations(phone, text, session, intent);
    case 'corporate':      return handleCorporateFlow(phone, text, session, intent);
    case 'fallback':       return handleFallback(phone, session.language, session.fallbackCount);
    default:               return showMainMenu(phone, session.language);
  }
}

function checkLanguageOverride(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return null;
  // English
  if (['english', 'eng', 'angreji', 'angrezi', 'अंग्रेज़ी', 'अंग्रेजी', 'અંગ્રેજી'].includes(t)) return 'english';
  // Hindi
  if (['hindi', 'hin', 'हिंदी', 'हिन्दी', 'હિન્દી'].includes(t)) return 'hindi';
  // Gujarati
  if (['gujarati', 'gujrati', 'guj', 'ગુજરાતી', 'गुजराती'].includes(t)) return 'gujarati';
  return null;
}

function verifySignature(req) {
  if (process.env.SKIP_WEBHOOK_SIGNATURE === '1' || process.env.SKIP_WEBHOOK_SIGNATURE === 'true') {
    // The skip flag is a local-debug tool only. In production a forgotten flag
    // would let anyone who finds the URL inject fake webhooks, so it is ignored.
    if (process.env.NODE_ENV === 'production') {
      console.error('[WEBHOOK] SKIP_WEBHOOK_SIGNATURE is set but NODE_ENV=production — flag IGNORED, HMAC still enforced.');
    } else {
      console.warn('[WEBHOOK] SKIP_WEBHOOK_SIGNATURE is set — not verifying HMAC (debug only)');
      return true;
    }
  }
  const secret = process.env.META_APP_SECRET?.trim();
  if (!secret) {
    // Production must have a secret. In dev we let it through so users can iterate
    // without setting one — but we shout about it in the logs each time.
    if (process.env.NODE_ENV === 'production') {
      console.error('[WEBHOOK] META_APP_SECRET is not set in production — rejecting all webhooks. '
        + 'Set META_APP_SECRET in .env or explicitly SKIP_WEBHOOK_SIGNATURE=1 (never in prod).');
      return false;
    }
    console.warn('[WEBHOOK] META_APP_SECRET empty (dev) — skipping HMAC. Fix before launch.');
    return true;
  }
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const body = req.rawBody || Buffer.from(JSON.stringify(req.body));
  try {
    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    const sigBuf = Buffer.from(String(sig), 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

module.exports = { handleWebhook };
