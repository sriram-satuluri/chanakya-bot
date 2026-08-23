const { sendTextMessage, sendButtonMessage, sendDocumentMessage } = require('../services/whatsapp');
const { addOrUpdateContact } = require('../services/sheets');
const { getSession, updateSession } = require('../utils/sessionStore');
const M = require('../messages/index');

// Redact phone to last-4 for logs. Same idea as webhook/handler.js — keeps logs
// useful for correlating a session without persisting full PII on hosted log tails.
const _rd = (p) => (p && p.length > 4) ? '***' + p.slice(-4) : '***';

/**
 * Auto-attach T&Cs PDF on first main menu of each fresh session. Set TERMS_DOC_URL
 * in .env to a publicly reachable HTTPS URL of the PDF (Cloudinary raw upload,
 * GitHub raw file, or any host on IMAGE_URL_ALLOWLIST). If not set, no doc is sent
 * — the terms_summary text and the /terms command still work.
 *
 * We fire this OUTSIDE the critical send path so a Cloudinary hiccup or a
 * bad-URL config can never block the welcome flow — customers still get their
 * greeting + menu even if the doc fails.
 */
async function maybeAttachTermsDoc(phone, lang) {
  const url = (process.env.TERMS_DOC_URL || '').trim();
  if (!url) return; // No URL configured → skip entirely; not an error.
  try {
    await sendDocumentMessage(
      phone,
      url,
      M.get('terms_doc_filename', lang),
      M.get('terms_doc_caption', lang),
    );
    console.log(`[MENU] T&Cs doc attached for ${_rd(phone)}`);
  } catch (e) {
    // Never let a doc-send failure kill the welcome flow.
    console.warn('[MENU] T&Cs doc send failed (non-fatal):', e.message);
  }
}

const MENU_BUTTONS = {
  english: [
    { id: 'btn_repair',    title: '🔧 Repair My Bag' },
    { id: 'btn_track',     title: '📍 Track My Repair' },
    { id: 'btn_language',  title: '🌐 Language' },
  ],
  hindi: [
    { id: 'btn_repair',    title: '🔧 बैग रिपेयर करें' },
    { id: 'btn_track',     title: '📍 रिपेयर ट्रैक करें' },
    { id: 'btn_language',  title: '🌐 भाषा बदलें' },
  ],
  gujarati: [
    { id: 'btn_repair',    title: '🔧 બેગ રિપેર કરો' },
    { id: 'btn_track',     title: '📍 રિપેર ટ્રૅક કરો' },
    { id: 'btn_language',  title: '🌐 ભાષા બદલો' },
  ],
};

const MENU_BUTTONS_2 = {
  english: [
    { id: 'btn_location',  title: '🗺️ Store Locations' },
    { id: 'btn_corporate', title: '🤝 Bulk / Corporate' },
    { id: 'btn_human',     title: '👤 Talk to a Person' },
  ],
  hindi: [
    { id: 'btn_location',  title: '🗺️ स्टोर का पता' },
    { id: 'btn_corporate', title: '🤝 बल्क/कॉर्पोरेट' },
    { id: 'btn_human',     title: '👤 स्टाफ से बात करें' },
  ],
  gujarati: [
    { id: 'btn_location',  title: '🗺️ સ્ટોરનું સ્થળ' },
    { id: 'btn_corporate', title: '🤝 બલ્ક / કૉર્પોરેટ' },
    { id: 'btn_human',     title: '👤 સ્ટાફ સાથે વાત' },
  ],
};

async function showMainMenu(phone, lang = 'english') {
  console.log(`[MENU] showMainMenu called for ${_rd(phone)} lang=${lang}`);
  // Register contact for broadcasts
  addOrUpdateContact(phone, lang).catch(() => {});

  // Prepend a random casual greeting the FIRST time we show the menu in this session.
  // After that, just show the constant welcome block so it doesn't get repetitive.
  const session = getSession(phone);
  let welcomeText = M.get('welcome', lang);
  const isFirstMenuOfSession = !session.greeted;
  if (isFirstMenuOfSession) {
    const greeting = M.randomGreeting(lang);
    welcomeText = `${greeting}\n\n${welcomeText}`;
    updateSession(phone, { greeted: true });
    console.log(`[MENU] First greeting for ${_rd(phone)}: "${greeting}"`);
  }

  const buttons1    = MENU_BUTTONS[lang]  || MENU_BUTTONS.english;
  const buttons2    = MENU_BUTTONS_2[lang] || MENU_BUTTONS_2.english;

  // Send welcome then two rows of buttons (WA max 3 per message)
  await sendButtonMessage(phone, welcomeText, buttons1);
  await sendButtonMessage(phone, M.get('menu_more_options', lang), buttons2);

  // Attach T&Cs PDF once per session — only on the first main-menu display.
  // This runs AFTER the menu is already delivered, so any doc-send failure
  // never blocks the core welcome flow.
  if (isFirstMenuOfSession && !session.termsDocSent) {
    updateSession(phone, { termsDocSent: true });
    maybeAttachTermsDoc(phone, lang).catch(() => {});
  }

  console.log(`[MENU] showMainMenu done for ${_rd(phone)}`);
}

module.exports = { showMainMenu };
