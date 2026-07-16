const { sendTextMessage, sendButtonMessage, sendDocumentMessage } = require('../services/whatsapp');
const M = require('../messages/index');

/**
 * One-shot Terms & Conditions handler. Sends the short summary text; if
 * TERMS_DOC_URL is configured (must be a Meta-fetchable HTTPS URL — see
 * IMAGE_URL_ALLOWLIST) the PDF is also attached. If only TERMS_URL is set
 * (e.g. a Google Drive link), it's included as a clickable line in the text.
 *
 * No session state — customer reads, then taps a button to go back.
 */
async function handleTermsRequest(phone, lang = 'english') {
  // Fill the {{terms_link_line}} placeholder in the summary. Empty string when
  // no URL is configured — clean output either way.
  const summary = M.fill(M.get('terms_summary', lang), {
    terms_link_line: M.termsLinkLine(lang),
  });
  await sendTextMessage(phone, summary);

  // Attach the PDF if a Meta-fetchable URL is configured.
  const docUrl = (process.env.TERMS_DOC_URL || '').trim();
  if (docUrl) {
    try {
      await sendDocumentMessage(
        phone,
        docUrl,
        M.get('terms_doc_filename', lang),
        M.get('terms_doc_caption', lang),
      );
    } catch (e) {
      console.warn('[TERMS] Doc attach failed (non-fatal):', e.message);
    }
  }

  const backButtons = {
    english:  [
      { id: 'btn_main_menu', title: '🏠 Main Menu' },
      { id: 'btn_repair',    title: '🔧 Repair a Bag' },
      { id: 'btn_shop',      title: '🛍️ Shop' },
    ],
    hindi:    [
      { id: 'btn_main_menu', title: '🏠 मुख्य मेनू' },
      { id: 'btn_repair',    title: '🔧 बैग रिपेयर' },
      { id: 'btn_shop',      title: '🛍️ खरीदें' },
    ],
    gujarati: [
      { id: 'btn_main_menu', title: '🏠 મુખ્ય મેનુ' },
      { id: 'btn_repair',    title: '🔧 બેગ રિપેર' },
      { id: 'btn_shop',      title: '🛍️ ખરીદો' },
    ],
  };

  return sendButtonMessage(
    phone,
    M.get('interactive_choose_next', lang),
    backButtons[lang] || backButtons.english,
  );
}

module.exports = { handleTermsRequest };
