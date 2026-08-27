const { sendTextMessage, sendButtonMessage } = require('../services/whatsapp');
const { createLead } = require('../services/sheets');
const { updateSession, clearSession } = require('../utils/sessionStore');
const { handleEscalation } = require('./escalate');
const { getRecipientsForCorporate } = require('../utils/ownerPhones');
const { notifyOwners } = require('../utils/ownerAlert');
const { getTimestamp, setTimestamp } = require('../utils/throttleStore');
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
      return sendTextMessage(phone, M.get('corporate_ask_name', lang));
    }

    case 'ask_contact_name': {
      if (!text || text.length < 2 || /^(btn_|bag_|prob_|store_|cat_)/.test(text)) {
        return sendTextMessage(phone, M.get('corporate_ask_name', lang));
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
      // Read-only here — we only record the timestamp after Sheets accepts the row,
      // otherwise a failed write would lock the customer out of retrying.
      const lastAt = getTimestamp('lead', phone);
      if (Date.now() - lastAt < LEAD_MIN_INTERVAL_MS) {
        clearSession(phone);
        return sendTextMessage(phone, M.get('corporate_throttle', lang));
      }

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
        return sendTextMessage(phone, M.get('corporate_create_failed', lang));
      }

      setTimestamp('lead', phone);

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
      // Fire-and-forget; a closed 24h window surfaces as [OWNER-ALERT-LOST].
      notifyOwners(getRecipientsForCorporate(), ownerMsg, {
        kind: 'new_corporate_lead',
        ref: leadId || '(no id)',
      });

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
