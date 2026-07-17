const crypto = require('crypto');
const { sendTextMessage, sendButtonMessage, sendListMessage, downloadMedia } = require('../services/whatsapp');
const { createRepairTicket } = require('../services/sheets');
const { uploadBuffer } = require('../services/cloudinary');
const { generateTicketId } = require('../utils/ticketId');
const { getRecipientsForRepair } = require('../utils/ownerPhones');
const { updateSession, clearSession } = require('../utils/sessionStore');
const {
  branchSlugFromRepairStoreId,
  defaultCallLine,
  directoryWithEmailAndWebForBranch,
  directoryWithEmailForBranch,
} = require('../constants/publicContact');
const { showMainMenu } = require('./mainMenu');
const { handleEscalation } = require('./escalate');
const M = require('../messages/index');

/** Normalize WhatsApp row titles vs typed text (unicode slashes, spacing). */
function normalizeInteractiveLabel(s = '') {
  return String(s)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\u2044\u2215／]/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
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

/** WhatsApp image as native image OR as document (image/jpeg …). Stickers rarely used for repairs. */
function getInboundImageMediaId(message = {}) {
  if (message.image?.id) return message.image.id;
  const doc = message.document;
  if (doc?.mime_type?.toLowerCase().startsWith('image/') && doc.id) return doc.id;
  if (message.sticker?.id) return message.sticker.id;
  return null;
}

// ── Main flow entry ───────────────────────────────────────────
async function handleRepairFlow(phone, text, msgType, rawMessage, session, intent = null) {
  const lang = session.language || 'english';

  if (intent === 'escalate') return handleEscalation(phone, lang);

  // If no active repair flow, start it
  if (!session.currentFlow || session.currentFlow !== 'repair') {
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
      if (!text || text.length < 2 || /^(btn_|bag_|prob_|store_|cat_)/.test(text) || text === '__IMAGE__') {
        return sendTextMessage(phone, M.get('ask_name', lang));
      }
      const name = text.trim();
      updateSession(phone, { flowStep: 'ask_bag_type', collectedData: { ...data, name } });
      return sendBagTypeMenu(phone, lang, name);
    }

    // ── Step 2: Bag type ──────────────────────────────────────
    case 'ask_bag_type': {
      const bagType = resolveBagType(text, lang);
      if (!bagType) return sendBagTypeMenu(phone, lang, data.name);
      updateSession(phone, { flowStep: 'ask_problem', collectedData: { ...data, bagType } });
      return sendProblemMenu(phone, lang, bagType);
    }

    // ── Step 3: Problem ───────────────────────────────────────
    case 'ask_problem': {
      const problem = resolveProblem(text, lang);
      if (!problem) return sendProblemMenu(phone, lang, data.bagType);
      updateSession(phone, { flowStep: 'ask_photo', collectedData: { ...data, problem } });
      return sendTextMessage(phone, M.get('ask_photo', lang));
    }

    // ── Step 4: Photo ─────────────────────────────────────────
    case 'ask_photo': {
      const mediaId = getInboundImageMediaId(rawMessage);
      if (!mediaId) {
        const nudge = {
          english:
            `Please send a *photo* of your bag (camera icon or 📎). Use JPG/PNG/WebP — WhatsApp sends some photos as documents; either way works.`,
          hindi:
            `कृपया अपने बैग की *फोटो* भेजें (📎 या कैमरा)। JPG/PNG.`,
          gujarati:
            `કૃપા કરીને બેગની *ફોટો* મોકલો (📎 અથવા કૅમેરા). JPG/PNG.`,
        };
        return sendTextMessage(phone, nudge[lang] || nudge.english);
      }

      let beforePhotoUrl = '';
      try {
        const imgBuffer = await downloadMedia(mediaId);
        // Do NOT put the customer's phone in the public_id — Cloudinary URLs are
        // unauthenticated and public, and this URL travels into owner alerts and
        // the sheet, so the phone would leak to anyone who sees it. Use a random
        // token instead; the ticket row still links the photo to the customer.
        const filename = `before_${crypto.randomBytes(8).toString('hex')}_${Date.now()}`;
        beforePhotoUrl = await uploadBuffer(imgBuffer, 'chanakya-repairs/before', filename);
      } catch (err) {
        console.error('[PHOTO] Download/upload failed:', err.message || err);
      }

      updateSession(phone, { flowStep: 'ask_store', collectedData: { ...data, beforePhotoUrl } });

      if (!beforePhotoUrl) {
        const warn =
          lang === 'hindi'
            ? 'फोटो सेव नहीं हो पाई। टिकट फिर भी बना सकते हैं — स्टोर पर बैग लाते समय दोबारा दिखा दीजिए।'
            : lang === 'gujarati'
              ? 'ફોટો સેવ થઈ શકી નહીં. ટિકિટ તો બનાવી શકાય છે — બેગ સ્ટોર પર લાવો ત્યારે ફરી બતાવજો.'
              : 'We could not store the photo — you can continue with the ticket. Please re-show it to us when you drop the bag off in store.';
        await sendTextMessage(phone, warn).catch(() => {});
      }

      return sendStoreMenu(phone, lang, beforePhotoUrl ? 'ok' : 'failed');
    }

    // ── Step 5: Store selection ───────────────────────────────
    case 'ask_store': {
      const store = resolveStore(text);
      if (!store) return sendStoreMenu(phone, lang);

      // All data collected — create ticket!
      const storeName = STORE_NAMES[store];
      let ticketId;
      try {
        ticketId = await generateTicketId();
        await createRepairTicket({
          ticketId,
          customerName:   data.name,
          phone,
          bagType:        data.bagType,
          problem:        data.problem,
          store:          storeName,
          beforePhotoUrl: data.beforePhotoUrl || '',
          language:       lang,
        });
        // Log-safe: don't persist full customer name + phone to log tails.
        const _rp = (p) => (p && p.length > 4) ? '***' + p.slice(-4) : '***';
        console.log(`[TICKET] Created ${ticketId} for ${_rp(phone)}`);

        const ownerMsg =
          `🔧 *New repair ticket*\n\n` +
          `🎫 *Ticket:* ${ticketId}\n` +
          `👤 *Customer:* ${data.name}\n` +
          `📞 *Phone:* ${phone}\n` +
          `👜 *Bag:* ${data.bagType}\n` +
          `🔧 *Issue:* ${data.problem}\n` +
          `🏪 *Store:* ${storeName}\n` +
          `📸 *Photo:* ${data.beforePhotoUrl || '—'}\n` +
          `🌐 *Language:* ${lang}`;
        // Notify general owners + any branch-specific owner (Nilesh for Sursagar, etc.)
        const branchSlugForAlerts = branchSlugFromRepairStoreId(store);
        const recipients = getRecipientsForRepair(branchSlugForAlerts);
        for (const ownerPhone of recipients) {
          sendTextMessage(ownerPhone, ownerMsg).catch((e) => {
            console.error(`[OWNER-ALERT] Failed to notify ${ownerPhone} about ticket ${ticketId}:`, e.message);
          });
        }
      } catch (err) {
        console.error('[TICKET] Creation failed:', err.message);
        const errMsg = {
          english: `Sorry, there was a technical issue creating your ticket. Please call us directly:\n${defaultCallLine()}`,
          hindi:   `माफ़ करें, टिकट बनाने में तकनीकी समस्या हुई। सीधे कॉल करें:\n${defaultCallLine()}`,
          gujarati:`માફ કરશો, ટિકિટ બનાવવામાં તકનીકી સમસ્યા આવી. કૃપા કરીને સીધો કૉલ કરો:\n${defaultCallLine()}`,
        };
        clearSession(phone);
        return sendTextMessage(phone, errMsg[lang] || errMsg.english);
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

      // Offer to go back to main menu
      const backButtons = {
        english:  [{ id: 'btn_main_menu', title: '🏠 Main Menu' },    { id: 'btn_track', title: '📍 Track Repair' }],
        hindi:    [{ id: 'btn_main_menu', title: '🏠 मुख्य मेनू' },     { id: 'btn_track', title: '📍 ट्रैक करें' }],
        gujarati: [{ id: 'btn_main_menu', title: '🏠 મુખ્ય મેનુ' }, { id: 'btn_track', title: '📍 ટ્રૅક કરો' }],
      };
      return sendButtonMessage(phone, M.get('interactive_choose_next', lang), backButtons[lang] || backButtons.english);
    }

    default:
      clearSession(phone);
      return showMainMenu(phone, lang);
  }
}

// ── Menu helpers ──────────────────────────────────────────────
async function sendBagTypeMenu(phone, lang, name) {
  const prompt = M.fill(M.get('ask_bag_type', lang), { name });
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
 * @param {'ok'|'failed'} photoStatus  'ok' shows the ✅ line; 'failed' skips it so
 *   we don't contradict the "photo could not be saved" warning shown right before.
 */
async function sendStoreMenu(phone, lang, photoStatus = 'ok') {
  const stores = STORES[lang] || STORES.english;
  let prompt;
  if (photoStatus === 'failed') {
    // Ask about store without claiming we received the photo (we didn't)
    prompt = {
      english:  `Which store will you bring the bag to?\n\n📍 *Alkapuri* — Race Course Road\n📍 *Sursagar* — Opp. Pratap Talkies`,
      hindi:    `आप बैग किस स्टोर पर लाएंगे?\n\n📍 *Alkapuri* — Race Course Road\n📍 *Sursagar* — Pratap Talkies के सामने`,
      gujarati: `આપ બેગ કયા સ્ટોર પર લઈ આવશો?\n\n📍 *Alkapuri* — Race Course Road\n📍 *Sursagar* — Pratap Talkies સામે`,
    }[lang] || `Which store will you bring the bag to?`;
  } else {
    prompt = M.get('photo_received', lang);
  }
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
