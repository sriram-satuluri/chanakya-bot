const { sendTextMessage, sendButtonMessage, sendImageMessage, sendListMessage } = require('../services/whatsapp');
const { findTicket, findTicketsByPhone } = require('../services/sheets');
const { updateSession, clearSession } = require('../utils/sessionStore');
const { handleEscalation } = require('./escalate');
const M = require('../messages/index');
const { tryParseTicketId } = require('../utils/ticketParse');
const { DEFAULT_REPAIR_TICKET_STATUS } = require('../constants/repairTicketStatuses');
const { defaultCallLine } = require('../constants/publicContact');

const STATUS_MSG_KEY = {
  'Bag Received':        'status_bag_received',
  'Inspection Done':     'status_inspection_done',
  'Repair In Progress':  'status_repair_in_progress',
  'Repair Complete':     'status_repair_in_progress', // reuse
  'Ready for Pickup':    'status_ready_pickup',
  'Cannot Repair':       'status_cannot_repair',
};

/**
 * Short, scannable status label for the ticket-picker rows (WhatsApp caps a row
 * description at 72 chars, so the full status message won't fit — especially the
 * long default "Bag Yet To Be Received…" string). Localised to the customer's
 * language. An unrecognised/custom status typed by staff is shown as-is.
 */
const SHORT_STATUS = {
  [DEFAULT_REPAIR_TICKET_STATUS]: { english: '⏳ Awaiting drop-off', hindi: '⏳ ड्रॉप-ऑफ बाकी',   gujarati: '⏳ ડ્રોપ-ઓફ બાકી' },
  'Bag Received':                 { english: '📥 Bag received',      hindi: '📥 बैग मिला',        gujarati: '📥 બેગ મળી' },
  'Inspection Done':              { english: '🔍 Inspected',         hindi: '🔍 जांच पूरी',        gujarati: '🔍 તપાસ પૂરી' },
  'Repair In Progress':           { english: '🔧 In progress',       hindi: '🔧 चल रही है',        gujarati: '🔧 ચાલુ છે' },
  'Repair Complete':              { english: '🔧 Repair done',       hindi: '🔧 रिपेयर पूरी',      gujarati: '🔧 રિપેર પૂરી' },
  'Ready for Pickup':             { english: '✅ Ready for pickup',   hindi: '✅ पिकअप के लिए तैयार', gujarati: '✅ પિકઅપ માટે તૈયાર' },
  'Cannot Repair':                { english: '❌ Cannot repair',      hindi: '❌ रिपेयर संभव नहीं',  gujarati: '❌ રિપેર શક્ય નથી' },
  'Picked Up':                    { english: '🎒 Picked up',         hindi: '🎒 ले लिया',          gujarati: '🎒 લઈ ગયા' },
};

function shortStatusLabel(status, lang) {
  const s = String(status ?? '').trim();
  const entry = SHORT_STATUS[s];
  if (entry) return entry[lang] || entry.english;
  return s || '—'; // custom status typed by staff — show it verbatim
}

async function handleTrackFlow(phone, text, session, intent = null) {
  const lang = session.language || 'english';

  if (intent === 'escalate') return handleEscalation(phone, lang);

  const firstEntry = !session.currentFlow || session.currentFlow !== 'track';

  if (firstEntry) {
    updateSession(phone, { currentFlow: 'track', flowStep: 'ask_ticket_id' });

    // If they already pasted a ticket reference ("track CHA-…", unicode dashes,
    // lowercase, …) honour it directly.
    const parsed = tryParseTicketId(text);
    if (parsed) return lookupAndSend(phone, parsed, lang);

    // Verified self-service: the WhatsApp sender number is guaranteed by Meta,
    // so surface THIS number's own tickets. No ID to remember, and there is no
    // way to list someone else's tickets.
    let mine;
    try {
      mine = await findTicketsByPhone(phone);
    } catch (err) {
      console.error('[TRACK] by-phone lookup failed, falling back to manual ID:', err.message);
      return sendTextMessage(phone, M.get('track_ask_id', lang));
    }

    if (mine.length === 0) {
      // Nothing under this number. Keep the flow open so they can type an ID
      // (e.g. a ticket raised under a different number, or by staff on their
      // behalf) — the ownership check below still guards it.
      return sendTextMessage(phone, noTicketsPrompt(lang));
    }
    if (mine.length === 1) {
      clearSession(phone);
      return lookupAndSend(phone, mine[0].ticketId, lang);
    }
    // More than one → let them pick.
    updateSession(phone, { flowStep: 'pick_ticket' });
    return sendTicketPicker(phone, lang, mine);
  }

  // Already in track flow — the message is a tapped ticket row, the
  // "enter a number" option, or a typed ID.
  if (text === 'track_enter_id') {
    updateSession(phone, { flowStep: 'ask_ticket_id' });
    return sendTextMessage(phone, M.get('track_ask_id', lang));
  }

  const canonical = tryParseTicketId(text);
  if (canonical) {
    clearSession(phone);
    return lookupAndSend(phone, canonical, lang);
  }

  // Invalid input while picking → re-show their ticket list instead of a dead end.
  if (session.flowStep === 'pick_ticket') {
    let mine = [];
    try { mine = await findTicketsByPhone(phone); } catch { mine = []; }
    if (mine.length > 1) return sendTicketPicker(phone, lang, mine);
    if (mine.length === 1) { clearSession(phone); return lookupAndSend(phone, mine[0].ticketId, lang); }
  }

  // Otherwise re-ask for a typed ID.
  clearSession(phone);
  const msg = {
    english: `That doesn't look like a valid Ticket ID. Format: *CHA-2026-0042* (capital letters aren't required).\n\nPlease try again:`,
    hindi:   `यह Ticket ID सही नहीं लगती। Format: *CHA-2026-0042* (बड़े-छोटे अक्षर ज़रूरी नहीं)।\n\nदोबारा कोशिश करें:`,
    gujarati:`આ Ticket ID સાચી નથી લાગતી। Format: *CHA-2026-0042* (મોટા-નાના અક્ષર જરૂરી નથી).\n\nફરીથી પ્રયાસ કરો:`,
  };
  await sendTextMessage(phone, msg[lang] || msg.english);
  updateSession(phone, { currentFlow: 'track', flowStep: 'ask_ticket_id' });
  return;
}

/**
 * Interactive picker of the caller's own tickets. WhatsApp lists allow at most
 * 10 rows; findTicketsByPhone already caps at the 10 newest. The description
 * shows bag + problem (both stored in the customer's language) so near-identical
 * tickets are still distinguishable; the ticket ID is the row title.
 */
async function sendTicketPicker(phone, lang, tickets) {
  // 9 tickets + 1 "enter a number" row = WhatsApp's 10-row list maximum.
  const rows = tickets.slice(0, 9).map((t) => {
    // Lead with the live status (what they came to see), then the bag to tell
    // near-identical tickets apart. Ticket ID is the row title for uniqueness.
    const bits = [shortStatusLabel(t.status, lang), t.bagType].filter(Boolean).join(' · ');
    const row = {
      id: String(t.ticketId),
      title: String(t.ticketId).substring(0, 24),
    };
    // Graph rejects an empty description string — only include it when non-empty.
    if (bits) row.description = bits.substring(0, 72);
    return row;
  });

  // Family/friend tracking: a ticket booked from another phone can be tracked
  // here by typing its ID.
  const enterIdRow = {
    english:  { title: '🔖 Enter ticket number', description: 'Track a ticket booked from another number' },
    hindi:    { title: '🔖 टिकट नंबर डालें', description: 'दूसरे नंबर से बने टिकट को ट्रैक करें' },
    gujarati: { title: '🔖 ટિકિટ નંબર લખો', description: 'બીજા નંબરથી બનેલી ટિકિટ ટ્રૅક કરો' },
  };
  const eir = enterIdRow[lang] || enterIdRow.english;
  rows.push({ id: 'track_enter_id', title: eir.title.substring(0, 24), description: eir.description.substring(0, 72) });

  const header = { english: 'Your Repairs', hindi: 'आपकी रिपेयर', gujarati: 'તમારી રિપેર' };
  const body = {
    english: `We found these repairs under your number. Tap one to see its live status:`,
    hindi:   `आपके नंबर पर ये रिपेयर मिलीं। स्थिति देखने के लिए किसी एक पर टैप करें:`,
    gujarati:`તમારા નંબર પર આ રિપેર મળી. સ્ટેટસ જોવા કોઈ એક પર ટૅપ કરો:`,
  };
  const section = { english: 'Your tickets', hindi: 'आपके टिकट', gujarati: 'તમારા ટિકિટ' };
  const btn = { english: 'Select ticket', hindi: 'टिकट चुनें', gujarati: 'ટિકિટ પસંદ કરો' };

  return sendListMessage(
    phone,
    header[lang] || header.english,
    body[lang] || body.english,
    btn[lang] || btn.english,
    [{ title: section[lang] || section.english, rows }],
  );
}

/** Shown when no ticket exists under the caller's number. */
function noTicketsPrompt(lang) {
  const msg = {
    english: `I couldn't find any repair under this number. If your ticket was booked with a different number, type its ID (e.g. *CHA-2026-0042*). Otherwise tap 🔧 to start a new repair.`,
    hindi:   `इस नंबर पर कोई रिपेयर नहीं मिली। अगर टिकट किसी और नंबर से बना है तो उसकी ID टाइप करें (जैसे *CHA-2026-0042*)। वरना नई रिपेयर के लिए 🔧 टैप करें।`,
    gujarati:`આ નંબર પર કોઈ રિપેર મળી નહીં. જો ટિકિટ બીજા નંબરથી બન્યું હોય તો તેની ID ટાઈપ કરો (દા.ત. *CHA-2026-0042*). નહીંતર નવી રિપેર માટે 🔧 ટૅપ કરો.`,
  };
  return msg[lang] || msg.english;
}

/**
 * Normalise a WhatsApp/Meta phone number for equality checks.
 * Meta gives country-code-first digits (e.g. 919876543210). Some sheet rows may
 * have +91 prefixes or spaces from manual edits. Compare on the digits-only form.
 */
function normPhone(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}

/**
 * Anti-enumeration budget for shared tracking: each phone may make at most
 * CROSS_LOOKUP_MAX lookups per hour that are either misses or views of a
 * ticket booked from another number. A mum checking her son's ticket uses 1;
 * a scraper walking sequential IDs runs dry after a handful.
 */
const CROSS_LOOKUP_MAX = 5;
const CROSS_LOOKUP_WINDOW_MS = 60 * 60 * 1000;
const _crossLookups = new Map(); // askerPhone -> { count, resetAt }
setInterval(() => {
  const now = Date.now();
  for (const [p, b] of _crossLookups) if (b.resetAt < now) _crossLookups.delete(p);
}, 15 * 60 * 1000).unref();

function allowCrossLookup(askerNorm) {
  const now = Date.now();
  let b = _crossLookups.get(askerNorm);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + CROSS_LOOKUP_WINDOW_MS };
    _crossLookups.set(askerNorm, b);
  }
  b.count++;
  return b.count <= CROSS_LOOKUP_MAX;
}

async function lookupAndSend(phone, ticketId /* canonical */, lang) {
  let ticket;
  try {
    ticket = await findTicket(ticketId);
  } catch (err) {
    console.error('[TRACK] Sheets lookup error:', err.message);
    const errMsg = {
      english: `Sorry, I couldn't check the status right now. Please try again shortly or reach us:\n${defaultCallLine()}`,
      hindi:   `माफ़ करें, अभी स्थिति जांच नहीं हो पाई। थोड़ी देर बाद कोशिश करें:\n${defaultCallLine()}`,
      gujarati:`માફ કરશો, આ સમયે સ્ટેટસ તપાસાયો નથી. થોડી વાર પછી ફરી પ્રયાસ કરો અથવા:\n${defaultCallLine()}`,
    };
    return sendTextMessage(phone, errMsg[lang] || errMsg.english);
  }

  // Shared-tracking model (product decision): anyone who knows the EXACT
  // ticket ID may view its status — like a courier tracking number — so a
  // family member can track a ticket booked from another phone. The status
  // reply deliberately contains no customer name or phone number.
  //
  // Because ticket IDs are sequential (guessable), cross-phone and not-found
  // lookups are throttled per asking phone so nobody can enumerate
  // CHA-2026-0001…9999 fishing for hits. Store owners and the ticket's own
  // phone are never throttled.
  const { getGeneralOwnerPhones, getBranchOwnerPhones } = require('../utils/ownerPhones');
  const ownerAllowlist = new Set([
    ...getGeneralOwnerPhones(),
    ...getBranchOwnerPhones('alkapuri'),
    ...getBranchOwnerPhones('sursagar'),
  ].map(normPhone));

  const askerNorm  = normPhone(phone);
  const ticketNorm = ticket ? normPhone(ticket.phone) : '';
  const isOwner = ownerAllowlist.has(askerNorm);
  const isOwnTicket = ticket && askerNorm === ticketNorm;

  const rd = (p) => (p && p.length > 4) ? '***' + p.slice(-4) : '***';
  if (!isOwner && !isOwnTicket) {
    // Cross-phone view (found) or a miss — both count toward the guess budget.
    if (!allowCrossLookup(askerNorm)) {
      console.warn(`[TRACK] lookup throttled for ${rd(askerNorm)} (too many cross/miss lookups)`);
      const throttleMsg = {
        english: `Too many ticket lookups in a short time. Please try again in an hour, or call us:\n${defaultCallLine()}`,
        hindi:   `थोड़े समय में बहुत सारी ticket जांच हो गई हैं। कृपया एक घंटे बाद फिर कोशिश करें, या कॉल करें:\n${defaultCallLine()}`,
        gujarati:`ટૂંકા સમયમાં ઘણી ટિકિટ તપાસ થઈ ગઈ છે. કૃપા કરીને એક કલાક પછી ફરી પ્રયાસ કરો, અથવા કૉલ કરો:\n${defaultCallLine()}`,
      };
      return sendTextMessage(phone, throttleMsg[lang] || throttleMsg.english);
    }
    if (ticket) {
      console.log(`[TRACK] shared view: ${rd(askerNorm)} viewed ${ticket.ticketId} (booked by ${rd(ticketNorm)})`);
    }
  }

  if (!ticket) {
    await sendTextMessage(phone, M.fill(M.get('track_not_found', lang), { id: ticketId }));
    // Give the customer an escape hatch — otherwise they're staring at an error with no next action.
    const notFoundButtons = {
      english:  [{ id: 'btn_track',     title: '🔁 Try Again' },     { id: 'btn_repair',    title: '🔧 New Repair' },  { id: 'btn_main_menu', title: '🏠 Main Menu' }],
      hindi:    [{ id: 'btn_track',     title: '🔁 दोबारा' },         { id: 'btn_repair',    title: '🔧 नई रिपेयर' },   { id: 'btn_main_menu', title: '🏠 मेनू' }],
      gujarati: [{ id: 'btn_track',     title: '🔁 ફરી પ્રયાસ' },  { id: 'btn_repair',    title: '🔧 નવી રિપેર' }, { id: 'btn_main_menu', title: '🏠 મેનુ' }],
    };
    return sendButtonMessage(phone, M.get('interactive_choose_next', lang), notFoundButtons[lang] || notFoundButtons.english);
  }

  // Special case: already picked up
  if (ticket.status === 'Picked Up') {
    const msg = {
      english: `✅ Ticket *${ticketId}* — This bag has already been *collected*. Thank you for choosing Chanakya! 🎒`,
      hindi:   `✅ Ticket *${ticketId}* — यह बैग *पहले ही ले लिया* गया है। Chanakya चुनने के लिए धन्यवाद! 🎒`,
      gujarati:`✅ Ticket *${ticketId}* — આ બેગ *પહેલેથી લઈ લેવાઈ* છે. Chanakya પસંદ કરવા બદલ આભાર! 🎒`,
    };
    return sendTextMessage(phone, msg[lang] || msg.english);
  }

  // Build message for this status
  const msgKey =
    STATUS_MSG_KEY[ticket.status]
    ?? (ticket.status === DEFAULT_REPAIR_TICKET_STATUS ? 'status_physical_pending' : 'status_poller_generic');
  let afterPhotoText = '';

  if (ticket.status === 'Ready for Pickup' && ticket.afterPhotoUrl) {
    afterPhotoText = lang === 'hindi'
      ? `📸 *मरम्मत के बाद की फोटो:*`
      : lang === 'gujarati'
      ? `📸 *રિપેર પછીની ફોટો:*`
      : `📸 *After repair photo:*`;
  }

  const statusMsg = M.fill(M.get(msgKey, lang), {
    ticketId:     ticket.ticketId,
    store:        ticket.store,
    estimatedPickup: ticket.estimatedPickup || '—',
    afterPhotoText,
    status:       ticket.status ?? '',
  });

  await sendTextMessage(phone, statusMsg);

  // Send after photo if ready for pickup
  if (ticket.status === 'Ready for Pickup' && ticket.afterPhotoUrl) {
    await sendImageMessage(phone, ticket.afterPhotoUrl, `After repair — Ticket ${ticketId}`);
  }

  // Action buttons
  const actionButtons = {
    english:  [{ id: 'btn_main_menu', title: '🏠 Main Menu' }, { id: 'btn_repair', title: '🔧 New Repair' }],
    hindi:    [{ id: 'btn_main_menu', title: '🏠 मुख्य मेनू' }, { id: 'btn_repair', title: '🔧 नई रिपेयर' }],
    gujarati: [{ id: 'btn_main_menu', title: '🏠 મુખ્ય મેનુ' }, { id: 'btn_repair', title: '🔧 નવી રિપેર' }],
  };
  await sendButtonMessage(phone, M.get('interactive_choose_next', lang), actionButtons[lang] || actionButtons.english);
}

module.exports = { handleTrackFlow };
