const { sendTextMessage, sendButtonMessage, sendListMessage } = require('../services/whatsapp');
const { createRepairTicket, getCustomerName, setCustomerName } = require('../services/sheets');
const { getTimestamp, setTimestamp } = require('../utils/throttleStore');
const { generateTicketId } = require('../utils/ticketId');
const { getRecipientsForRepair } = require('../utils/ownerPhones');
const { notifyOwners } = require('../utils/ownerAlert');
const { updateSession, clearSession } = require('../utils/sessionStore');
const {
  branchSlugFromRepairStoreId,
  directoryWithEmailAndWebForBranch,
  directoryWithEmailForBranch,
} = require('../constants/publicContact');
const { showMainMenu } = require('./mainMenu');
const { handleEscalation } = require('./escalate');
const { askRepairUpdatesOptIn } = require('./repairUpdates');
const { envInt } = require('../utils/env');
const M = require('../messages/index');

/** Redact a phone to last-4 for logs. Module scope so it's also in scope in
 *  the owner-alert error path, not just inside the ticket-create try block. */
const _rp = (p) => (p && p.length > 4) ? '***' + p.slice(-4) : '***';

/**
 * Per-phone repair-ticket throttle. Mirrors the corporate-lead throttle in
 * flows/corporate.js — without it, a scripted sender could loop the repair
 * flow and generate unlimited tickets, each one costing a Sheets write plus
 * 2-3 billable owner-alert WhatsApp messages. The outbound circuit breaker in
 * utils/sendGuard.js is only a last-resort backstop; this stops the abuse at
 * the source and keeps the sheet clean.
 *
 * Deliberately generous: a genuine customer with several bags to book will
 * space them out by more than this, and anyone legitimately hitting the limit
 * is told to call the store rather than being silently dropped.
 */
const TICKET_MIN_INTERVAL_MS = envInt('TICKET_MIN_INTERVAL_MINUTES', 10, { min: 0 }) * 60 * 1000;

/** Normalize WhatsApp row titles vs typed text (unicode slashes, spacing). */
function normalizeInteractiveLabel(s = '') {
  return String(s)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\u2044\u2215／]/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikePersonName(text) {
  const t = String(text || '').trim();
  if (t.length < 2 || t.length > 40) return false;
  if (/^(btn_|bag_|prob_|store_|cat_|lang_|combo_)/i.test(t)) return false;
  if (/^\d+$/.test(t)) return false;
  return true;
}

// ── Bag types & problems ──────────────────────────────────────
const BAG_TYPES = {
  english:  ['Trolley / Luggage Bag', 'Backpack', 'School Bag', 'Laptop Bag', 'Handbag / Purse', 'Duffel Bag', 'Other'],
  hindi:    ['ट्रॉली / लगेज बैग', 'बैकपैक', 'स्कूल बैग', 'लैपटॉप बैग', 'हैंडबैग / पर्स', 'डफल बैग', 'अन्य'],
  gujarati: ['ટ્રૉલી / લગેજ બેગ', 'બેકપૅક', 'સ્કૂલ બેગ', 'લૅપટૉપ બેગ', 'હૅન્ડબેગ / પર્સ', 'ડફલ બેગ', 'અન્ય'],
};

const PROBLEMS = {
  english:  ['Zip / Chain Issue', 'Wheel Issue', 'Handle Issue', 'Lock Issue', 'Stitching / Tear', 'Cleaning / Polishing', 'Lining Issue', 'Other'],
  hindi:    ['ज़िप / चेन की समस्या', 'व्हील की समस्या', 'हैंडल की समस्या', 'लॉक की समस्या', 'सिलाई / फटा हुआ', 'सफाई / पॉलिश', 'लाइनिंग', 'अन्य'],
  gujarati: ['ઝિપ / ચેઈનની સમસ્યા', 'વ્હીલની સમસ્યા', 'હૅન્ડલની સમસ્યા', 'લૉકની સમસ્યા', 'સિલાઈ / ફાટ', 'સફાઈ / પૉલિશ', 'લાઇનિંગ', 'અન્ય'],
};

// WhatsApp caps interactive-button titles at 20 characters (API limit), so the
// labels must be complete words that FIT — never let long text get chopped
// mid-word ("Alkapuri — Race Cour"). Store names alone are unambiguous; the
// full address is shown in the confirmation + contact messages that follow.
const STORES = {
  english:  [
    { id: 'store_alkapuri', label: '📍 Alkapuri' },
    { id: 'store_sursagar', label: '📍 Sursagar' },
  ],
  hindi: [
    { id: 'store_alkapuri', label: '📍 Alkapuri' },
    { id: 'store_sursagar', label: '📍 Sursagar' },
  ],
  gujarati: [
    { id: 'store_alkapuri', label: '📍 Alkapuri' },
    { id: 'store_sursagar', label: '📍 Sursagar' },
  ],
};

const STORE_NAMES = {
  store_alkapuri: 'Alkapuri (Race Course Road)',
  store_sursagar: 'Sursagar (Opp. Pratap Talkies)',
};

// Fail fast if language lists drift (breaks bag_i / prob_i indexing)
(() => {
  const langs = ['english', 'hindi', 'gujarati'];
  const b = langs.map((L) => BAG_TYPES[L].length);
  const p = langs.map((L) => PROBLEMS[L].length);
  if (new Set(b).size !== 1 || new Set(p).size !== 1) {
    console.error('[REPAIR] BAG_TYPES or PROBLEMS length mismatch:', { bags: b, problems: p });
    throw new Error('repair menu: hindi/gujarati/english arrays must have the same lengths');
  }
})();

// ── Main flow entry ───────────────────────────────────────────
async function handleRepairFlow(phone, text, msgType, rawMessage, session, intent = null) {
  const lang = session.language || 'english';

  if (intent === 'escalate') return handleEscalation(phone, lang, text);

  // If no active repair flow, start it
  if (!session.currentFlow || session.currentFlow !== 'repair') {
    let remembered = null;
    try { remembered = await getCustomerName(phone); } catch (e) {
      console.warn(`[REPAIR] name lookup failed for ${_rp(phone)}:`, e.message);
    }
    if (remembered) {
      updateSession(phone, {
        currentFlow: 'repair',
        flowStep: 'ask_bag_type',
        collectedData: { name: remembered },
        reminderSent: false,
      });
      console.log(`[REPAIR] Remembered name for ${_rp(phone)} — skipping ask_name`);
      return sendBagTypeMenu(phone, lang, remembered, true);
    }
    updateSession(phone, {
      currentFlow: 'repair',
      flowStep: 'ask_name',
      collectedData: {},
      reminderSent: false,
    });
    return sendTextMessage(phone, M.get('ask_name', lang));
  }

  const step = session.flowStep;
  const data = session.collectedData || {};

  switch (step) {
    // ── Step 1: Collect name ──────────────────────────────────
    case 'ask_name': {
      // Reject empty/too-short input, button IDs (user double-tapped a menu
      // button), and __IMAGE__ — re-prompt for a real name instead of
      // storing "btn_repair" as the customer's name.
      if (!text || text.length < 2 || /^(btn_|bag_|prob_|store_|cat_|combo_)/.test(text) || text === '__IMAGE__') {
        return sendTextMessage(phone, M.get('ask_name', lang));
      }
      const name = text.trim();
      updateSession(phone, { flowStep: 'ask_bag_type', collectedData: { ...data, name } });
      setCustomerName(phone, name).catch((e) =>
        console.warn(`[REPAIR] Failed to persist name for ${_rp(phone)}:`, e.message));
      return sendBagTypeMenu(phone, lang, name);
    }

    // ── Step 2: Bag type (ask_what is an alias for in-flight combined-list sessions) ──
    case 'ask_what':
    case 'ask_bag_type': {
      const bagType = resolveBagType(text, lang);
      if (!bagType) {
        if (looksLikePersonName(text)) {
          const name = text.trim();
          updateSession(phone, { collectedData: { ...data, name } });
          setCustomerName(phone, name).catch((e) =>
            console.warn(`[REPAIR] Failed to persist name for ${_rp(phone)}:`, e.message));
          return sendBagTypeMenu(phone, lang, name);
        }
        return sendBagTypeMenu(phone, lang, data.name);
      }
      updateSession(phone, { flowStep: 'ask_problem', collectedData: { ...data, bagType } });
      return sendProblemMenu(phone, lang, bagType);
    }

    // ── Fallback: problem ("Something else" after bag type) ───
    case 'ask_problem': {
      const problem = resolveProblem(text, lang);
      if (!problem) return sendProblemMenu(phone, lang, data.bagType);
      // Store comes BEFORE the photo now: those four answers are everything we
      // need to create the ticket, so we bank them rather than holding them
      // hostage to an optional photo the customer may not be able to take yet.
      updateSession(phone, { flowStep: 'ask_store', collectedData: { ...data, problem } });
      return sendStoreMenu(phone, lang);
    }

    // ── Step 4 (final): Store selection → create the ticket ───
    case 'ask_store': {
      const store = resolveStore(text);
      if (!store) return sendStoreMenu(phone, lang);

      // Anti-spam throttle: one ticket per phone per TICKET_MIN_INTERVAL_MS.
      // Checked here (the last step) rather than at flow start, so a customer
      // isn't blocked from browsing the flow — only from committing a ticket.
      const lastTicketAt = getTimestamp('ticket', phone);
      if (TICKET_MIN_INTERVAL_MS > 0 && Date.now() - lastTicketAt < TICKET_MIN_INTERVAL_MS) {
        console.warn(`[TICKET] Throttled repeat ticket from ${_rp(phone)}`);
        clearSession(phone);
        return sendTextMessage(phone, M.get('ticket_throttle', lang));
      }

      // All four answers collected — create the ticket NOW.
      // The photo is deliberately not required here: those four facts are
      // everything the shop needs, and holding them in an in-memory session
      // until an optional photo arrives meant a redeploy (or a customer whose
      // bag is at home) silently destroyed the whole booking. The photo is
      // requested straight after and can arrive at any time later — see
      // findRecentTicketAwaitingPhoto / the late-photo handler in the webhook.
      const storeName = STORE_NAMES[store];
      let ticketId;
      try {
        ticketId = await generateTicketId(store);
        await createRepairTicket({
          ticketId,
          customerName:   data.name,
          phone,
          bagType:        data.bagType,
          problem:        data.problem,
          store:          storeName,
          beforePhotoUrl: '',   // arrives later
          language:       lang,
        });
        // Only count a ticket toward the throttle once it actually persisted —
        // a failed creation shouldn't lock the customer out of retrying.
        setTimestamp('ticket', phone);
        setCustomerName(phone, data.name).catch(() => {});
        // Log-safe: don't persist full customer name + phone to log tails.
        console.log(`[TICKET] Created ${ticketId} for ${_rp(phone)}`);

        const ownerMsg =
          `🔧 *New repair ticket*\n\n` +
          `🎫 *Ticket:* ${ticketId}\n` +
          `👤 *Customer:* ${data.name}\n` +
          `📞 *Phone:* ${phone}\n` +
          `👜 *Bag:* ${data.bagType}\n` +
          `🔧 *Issue:* ${data.problem}\n` +
          `🏪 *Store:* ${storeName}\n` +
          `📸 *Photo:* awaiting — customer asked to send one\n` +
          `🌐 *Language:* ${lang}`;
        // Notify general owners + any branch-specific owner (Nilesh for Sursagar, etc.)
        const branchSlugForAlerts = branchSlugFromRepairStoreId(store);
        const recipients = getRecipientsForRepair(branchSlugForAlerts);
        // Fire-and-forget: the customer must never wait on owner alerting, and
        // notifyOwners never throws. A 24h-window failure surfaces as
        // [OWNER-ALERT-LOST] rather than vanishing into a generic catch.
        notifyOwners(recipients, ownerMsg, { kind: 'new_ticket', ref: ticketId });
      } catch (err) {
        console.error('[TICKET] Creation failed:', err.message);
        clearSession(phone);
        return sendTextMessage(phone, M.get('ticket_create_failed', lang));
      }

      // Send confirmation
      const confirmMsg = M.fill(M.get('repair_confirmed', lang), {
        ticketId, bagType: data.bagType, problem: data.problem, store: storeName,
      });

      clearSession(phone);
      await sendTextMessage(phone, confirmMsg);
      // T&C reminder — records the customer's acceptance of key obligations.
      // No link here (T&Cs are already sent on the main menu); customers can
      // type "terms" any time to re-read them.
      await sendTextMessage(phone, M.get('terms_reminder_repair', lang)).catch(() => {});

      const branchSlug = branchSlugFromRepairStoreId(store);
      if (branchSlug) {
        const contactBody =
          lang === 'english'
            ? directoryWithEmailAndWebForBranch(branchSlug)
            : directoryWithEmailForBranch(branchSlug);
        await sendTextMessage(
          phone,
          M.fill(M.get('contact_for_store', lang), { storeName, contactBody }),
        );
      }

      // Finally: ask whether they want proactive updates on this ticket.
      // This parks the session on the 'repair_updates' flow to catch the
      // answer, so it replaces the old "what next?" buttons rather than
      // adding another message — the answer buttons double as the exit.
      return askRepairUpdatesOptIn(phone, lang, ticketId);
    }

    default:
      clearSession(phone);
      return showMainMenu(phone, lang);
  }
}

// ── Menu helpers ──────────────────────────────────────────────
async function sendBagTypeMenu(phone, lang, name, returning = false) {
  const prompt = M.fill(M.get(returning ? 'ask_bag_type_returning' : 'ask_bag_type', lang), { name });
  const types = BAG_TYPES[lang] || BAG_TYPES.english;

  return sendListMessage(
    phone,
    M.get('list_header_bag_type', lang),
    prompt,
    M.get('btn_select_short', lang),
    [{
      title: M.get('list_section_bag_type', lang),
      rows: types.map((t, i) => ({ id: `bag_${i}`, title: t.substring(0, 24) })),
    }]
  );
}

async function sendProblemMenu(phone, lang, bagType) {
  const prompt = M.fill(M.get('ask_problem', lang), { bagType });
  const probs = PROBLEMS[lang] || PROBLEMS.english;

  return sendListMessage(
    phone,
    M.get('list_header_problem', lang),
    prompt,
    M.get('btn_select_short', lang),
    [{
      title: M.get('list_section_problem', lang),
      rows: probs.map((p, i) => ({ id: `prob_${i}`, title: p.substring(0, 24) })),
    }]
  );
}

/**
 * Store picker — the last question before the ticket is created.
 *
 * Deliberately says nothing about a photo: the photo is now requested AFTER
 * the ticket exists, so the old "Photo received! ✅" wording that used to lead
 * this message was claiming something that hadn't happened yet.
 */
async function sendStoreMenu(phone, lang) {
  const stores = STORES[lang] || STORES.english;
  const prompt = {
    english:  `Almost done! Which store will you bring the bag to?\n\n📍 *Alkapuri* — Race Course Road\n📍 *Sursagar* — Opp. Pratap Talkies`,
    hindi:    `लगभग हो गया! आप बैग किस स्टोर पर लाएंगे?\n\n📍 *Alkapuri* — Race Course Road\n📍 *Sursagar* — Pratap Talkies के सामने`,
    gujarati: `લગભગ થઈ ગયું! આપ બેગ કયા સ્ટોર પર લઈ આવશો?\n\n📍 *Alkapuri* — Race Course Road\n📍 *Sursagar* — Pratap Talkies સામે`,
  }[lang] || `Almost done! Which store will you bring the bag to?`;
  return sendButtonMessage(phone, prompt, stores.map(s => ({ id: s.id, title: s.label.substring(0, 20) })));
}

// ── Resolvers (map button IDs back to human-readable values) ──
function rowLabelsMatch(canonicalCell, inboundNorm) {
  const full = normalizeInteractiveLabel(canonicalCell);
  const rowSnippet = normalizeInteractiveLabel(canonicalCell.substring(0, 24)); // WhatsApp list row limit
  return full === inboundNorm || rowSnippet === inboundNorm;
}

function resolveBagType(text, lang) {
  const m = text?.match(/^bag_(\d+)$/);
  if (m) {
    const idx = parseInt(m[1], 10);
    return BAG_TYPES[lang]?.[idx] ?? BAG_TYPES.english[idx] ?? null;
  }

  const nt = normalizeInteractiveLabel(text);
  if (!nt) return null;

  const langs = ['english', 'hindi', 'gujarati'];
  const n = Math.min(...langs.map((L) => BAG_TYPES[L].length));
  for (let i = 0; i < n; i++) {
    const cells = langs.map((L) => BAG_TYPES[L][i]);
    if (cells.some((c) => rowLabelsMatch(c, nt))) {
      return BAG_TYPES[lang]?.[i] ?? BAG_TYPES.english[i];
    }
  }
  return null;
}

function resolveProblem(text, lang) {
  const m = text?.match(/^prob_(\d+)$/);
  if (m) {
    const idx = parseInt(m[1], 10);
    return PROBLEMS[lang]?.[idx] ?? PROBLEMS.english[idx] ?? null;
  }

  const nt = normalizeInteractiveLabel(text);
  if (!nt) return null;

  const langs = ['english', 'hindi', 'gujarati'];
  const n = Math.min(...langs.map((L) => PROBLEMS[L].length));
  for (let i = 0; i < n; i++) {
    const cells = langs.map((L) => PROBLEMS[L][i]);
    if (cells.some((c) => rowLabelsMatch(c, nt))) {
      return PROBLEMS[lang]?.[i] ?? PROBLEMS.english[i];
    }
  }
  return null;
}

function resolveStore(text) {
  if (text === 'store_alkapuri') return 'store_alkapuri';
  if (text === 'store_sursagar') return 'store_sursagar';
  const t = text?.toLowerCase() || '';
  if (t.includes('alkapuri') || t.includes('race course')) return 'store_alkapuri';
  if (t.includes('sursagar') || t.includes('pratap')) return 'store_sursagar';
  return null;
}

module.exports = { handleRepairFlow };
