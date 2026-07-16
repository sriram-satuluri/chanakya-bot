const { sendTextMessage, sendButtonMessage } = require('../services/whatsapp');
const { updateSession, clearSession } = require('../utils/sessionStore');
const M = require('../messages/index');

async function handleEscalation(phone, lang = 'english') {
  // Pause bot for this number until the customer sends something else. Handler
  // auto-resumes on the next inbound message so the pause is a soft nudge, not a
  // hard block. See routeMessage in webhook/handler.js.
  updateSession(phone, {
    currentFlow: 'paused',
    flowStep: null,
    fallbackCount: 0,
    lastActivity: Date.now(),
  });

  await sendTextMessage(phone, M.get('escalate_message', lang));
  const rp = (p) => (p && p.length > 4) ? '***' + p.slice(-4) : '***';
  console.log(`[ESCALATE] Bot paused for ${rp(phone)}`);
}

async function handleFallback(phone, lang = 'english', fallbackCount = 1) {
  if (fallbackCount >= 3) {
    // Offer human after 3 failed attempts, then reset the counter so tapping
    // "Menu" and coming back doesn't insta-trigger the same escalation offer.
    updateSession(phone, { fallbackCount: 0 });
    const msg = M.get('fallback_offer_human', lang);
    const buttons = {
      english:  [{ id: 'btn_human', title: '👤 Talk to Team' },     { id: 'btn_main_menu', title: '🏠 Menu' }],
      hindi:    [{ id: 'btn_human', title: '👤 टीम से बात करें' },   { id: 'btn_main_menu', title: '🏠 मेनू' }],
      gujarati: [{ id: 'btn_human', title: '👤 ટીમ સાથે વાત' }, { id: 'btn_main_menu', title: '🏠 મેનુ' }],
    };
    return sendButtonMessage(phone, msg, buttons[lang] || buttons.english);
  }

  // Show main menu with gentle message
  const msg = M.get('fallback_once', lang);
  const { showMainMenu } = require('./mainMenu');
  await sendTextMessage(phone, msg);
  return showMainMenu(phone, lang);
}

module.exports = { handleEscalation, handleFallback };
