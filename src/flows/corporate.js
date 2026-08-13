const { sendTextMessage, sendButtonMessage } = require('../services/whatsapp');
const { createLead } = require('../services/sheets');
const { sendTemplateMessage } = require('../services/whatsapp');
const { updateSession, clearSession } = require('../utils/sessionStore');
const { handleEscalation } = require('./escalate');
const { getRecipientsForCorporate } = require('../utils/ownerPhones');
const M = require('../messages/index');

/**
 * Per-phone corporate-lead throttle. Someone determined to spam owners could
 * complete the corporate flow repeatedly and cause a wave of WhatsApp
 * notifications to Vedant / Vatsal (and rack up Sheet-write cost). We accept at
 * most one lead per phone every LEAD_MIN_INTERVAL_MS. On collision we thank the
 * customer, drop the second submission, and don't ping owners a second time.
 */
/** Redact a phone to last-4 for logs. Module scope so it's in scope in the
 *  owner-alert error path too, not just inside the create-lead try block. */
const _rp = (p) => (p && p.length > 4) ? '***' + p.slice(-4) : '***';

const LEAD_MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const _lastLeadAt = new Map(); // phone -> timestamp
setInterval(() => {
  const cutoff = Date.now() - LEAD_MIN_INTERVAL_MS * 2;
  for (const [p, ts] of _lastLeadAt) if (ts < cutoff) _lastLeadAt.delete(p);
}, 15 * 60 * 1000).unref();

async function handleCorporateFlow(phone, text, session, intent = null) {
  const lang = session.language || 'english';

  if (intent === 'escalate') return handleEscalation(phone, lang, text);

  const data = session.collectedData || {};

  if (!session.currentFlow || session.currentFlow !== 'corporate') {
    updateSession(phone, { currentFlow: 'corporate', flowStep: 'ask_company', collectedData: {} });
    await sendTextMessage(phone, M.get('corporate_intro', lang));
    return sendTextMessage(phone, M.get('corporate_ask_company', lang));
  }

  const step = session.flowStep;

  switch (step) {
    case 'ask_company': {
      // Reject empty input or button IDs (e.g., double-tap of the Corporate button,
      // or tap on an old menu button still visible in the chat history)
      if (!text || text.length < 2 || /^(btn_|bag_|prob_|store_|cat_)/.test(text)) {
        return sendTextMessage(phone, M.get('corporate_ask_company', lang));
      }
      updateSession(phone, { flowStep: 'ask_contact_name', collectedData: { ...data, company: text.trim() } });
      const q = { english: `Great! And your *name*?`, hindi: `बढ़िया! और आपका *नाम*?`, gujarati: `સરસ! અને આપનું *નામ*?` };
      return sendTextMessage(phone, q[lang] || q.english);
    }

    case 'ask_contact_name': {
      if (!text || text.length < 2 || /^(btn_|bag_|prob_|store_|cat_)/.test(text)) {
        const q = { english: `Great! And your *name*?`, hindi: `बढ़िया! और आपका *नाम*?`, gujarati: `સરસ! અને આપનું *નામ*?` };
        return sendTextMessage(phone, q[lang] || q.english);
      }
      updateSession(phone, { flowStep: 'ask_product_type', collectedData: { ...data, name: text.trim() } });
      return sendTextMessage(phone, M.get('corporate_ask_product', lang));
    }

    case 'ask_product_type': {
      if (!text || text.length < 2 || /^(btn_|bag_|prob_|store_|cat_)/.test(text)) {
        return sendTextMessage(phone, M.get('corporate_ask_product', lang));
      }
      updateSession(phone, { flowStep: 'ask_quantity', collectedData: { ...data, productType: text.trim() } });
      return sendTextMessage(phone, M.get('corporate_ask_quantity', lang));
    }

    case 'ask_quantity': {
      if (!text || /^(btn_|bag_|prob_|store_|cat_)/.test(text)) {
        return sendTextMessage(phone, M.get('corporate_ask_quantity', lang));
      }
      updateSession(phone, { flowStep: 'ask_branding', collectedData: { ...data, quantity: text.trim() } });
      return sendTextMessage(phone, M.get('corporate_ask_branding', lang));
    }

    case 'ask_branding': {
      if (!text || /^(btn_|bag_|prob_|store_|cat_)/.test(text)) {
        return sendTextMessage(phone, M.get('corporate_ask_branding', lang));
      }

      // Anti-spam throttle: same phone can't create more than one lead per hour.
      const lastAt = _lastLeadAt.get(phone) || 0;
      if (Date.now() - lastAt < LEAD_MIN_INTERVAL_MS) {
        const throttleMsg = {
          english:
            `We already have your recent enquiry on file — thanks! Our team will reach out shortly. If you need to send new details, please call:\n` +
            `📞 See main menu → 🤝 Bulk / Corporate later, or contact the team directly.`,
          hindi:
            `आपकी हाल की enquiry हमें मिल चुकी है — धन्यवाद! हमारी टीम जल्द ही संपर्क करेगी। नई जानकारी भेजनी हो तो कृपया थोड़ी देर बाद पुनः प्रयास करें।`,
          gujarati:
            `આપની હાલમાં કરેલી enquiry અમને મળી ગઈ છે — આભાર! અમારી ટીમ ટૂંક સમયમાં સંપર્ક કરશે. નવી વિગત મોકલવી હોય તો કૃપા કરીને થોડી વાર પછી ફરી પ્રયાસ કરો.`,
        };
        clearSession(phone);
        return sendTextMessage(phone, throttleMsg[lang] || throttleMsg.english);
      }
      _lastLeadAt.set(phone, Date.now());

      // All collected — create lead
      const finalData = { ...data, branding: text.trim(), phone, language: lang };

      let leadId;
      try {
        leadId = await createLead(finalData);
        // Log only the bot-generated id + redacted phone. Name/company are raw
        // customer input — logging them risks log-injection (newlines forging
        // fake lines) and puts PII in log tails. They're already in the sheet.
        console.log(`[LEAD] Created ${leadId} from ${_rp(phone)}`);
      } catch (err) {
        console.error('[LEAD] Failed to create:', err.message);
      }

      // Notify owners via WhatsApp
      const ownerMsg =
        `🔔 *New Corporate Enquiry!*\n\n` +
        `🏢 Company: ${finalData.company}\n` +
        `👤 Contact: ${finalData.name}\n` +
        `📞 Phone: ${phone}\n` +
        `🎒 Product: ${finalData.productType}\n` +
        `📦 Qty: ${finalData.quantity}\n` +
        `🖨️ Branding: ${finalData.branding}\n` +
        `🌐 Language: ${lang}`;

      // Corporate leads are branch-agnostic — general owners only, no branch-only extras.
      for (const ownerPhone of getRecipientsForCorporate()) {
        sendTextMessage(ownerPhone, ownerMsg).catch((e) => {
          console.error(`[OWNER-ALERT] Failed to notify ${_rp(ownerPhone)} about lead ${leadId || '(no id)'}:`, e.message);
        });
      }

      const confirmMsg = M.fill(M.get('corporate_confirmed', lang), {
        name:    finalData.name,
        company: finalData.company,
      });
      clearSession(phone);
      await sendTextMessage(phone, confirmMsg);
      // T&C reminder — particularly important for the sample-approval /
      // third-party-vendor process. URL is included only if configured.
      const termsReminder = M.fill(M.get('terms_reminder_corporate', lang), {
        terms_url_suffix: M.termsUrlSuffix(lang),
      });
      await sendTextMessage(phone, termsReminder).catch(() => {});

      const backButtons = {
        english:  [{ id: 'btn_main_menu', title: '🏠 Main Menu' },     { id: 'btn_location', title: '🗺️ Stores' }],
        hindi:    [{ id: 'btn_main_menu', title: '🏠 मुख्य मेनू' },    { id: 'btn_location', title: '🗺️ स्टोर' }],
        gujarati: [{ id: 'btn_main_menu', title: '🏠 મુખ્ય મેનુ' }, { id: 'btn_location', title: '🗺️ સ્ટોર' }],
      };
      return sendButtonMessage(phone, M.get('interactive_choose_next', lang), backButtons[lang] || backButtons.english);
    }

    default:
      clearSession(phone);
      const { showMainMenu } = require('./mainMenu');
      return showMainMenu(phone, lang);
  }
}

module.exports = { handleCorporateFlow };
