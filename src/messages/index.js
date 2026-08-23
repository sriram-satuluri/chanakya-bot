// Central message store for all 3 languages
// Usage: M.get('welcome', 'hindi')

const {
  defaultCallLine,
  directoryPhonesOnly,
  directoryWithEmail,
  directoryWithEmailAndWeb,
} = require('../constants/publicContact');
const {
  DEFAULT_REPAIR_TICKET_STATUS,
  canonicalStatus,
} = require('../constants/repairTicketStatuses');

// Random casual greeting prefixes shown ONCE per session, before the welcome block.
// Kept secular and community-neutral.
const greetingPrefixes = {
  english: [
    `Hey ya! 👋`,
    `Wassup! 😎`,
    `Hello hello! 👋`,
    `Hey there! ✨`,
    `Hiya! 🎒`,
    `Hey, glad you're here! 👋`,
    `Yo! What's up? 😄`,
    `Hi friend! 🤗`,
    `Hope you're doing well! 😊`,
    `Hey! Hope you're having a great day! ☀️`,
  ],
  hindi: [
    `अरे वाह, हैलो! 👋`,
    `और भाई, क्या हाल? 😄`,
    `हैलो जी! 👋`,
    `हैलो हैलो! 👋`,
    `अरे आइए आइए! ✨`,
    `और बताइए, कैसे हैं? 😊`,
    `स्वागत है आपका! 🎒`,
    `अरे क्या बात! 👋`,
    `उम्मीद है आप अच्छे होंगे! 😊`,
    `कैसे हैं आप? सब बढ़िया? ☀️`,
  ],
  gujarati: [
    `કેમ છો? 😊`,
    `અરે આવો આવો! ✨`,
    `હેલો જી! 👋`,
    `કેમ છો ભાઈ/બેન! 👋`,
    `અરે વાહ, સ્વાગત છે! ✨`,
    `શું ખબર? 😄`,
    `કેમ છો, મજામાં? 😊`,
    `અરે હેલો! 👋`,
    `તમારું સ્વાગત છે! 🎒`,
    `આશા છે કે તમે મજામાં હશો! 😊`,
  ],
};

function randomGreeting(lang) {
  const langKey = lang || 'english';
  const list = greetingPrefixes[langKey] || greetingPrefixes.english;
  return list[Math.floor(Math.random() * list.length)];
}

const messages = {
  welcome: {
    english: `Welcome to *Chanakya – The Bag Studio!* 🎒\nVadodara's #1 Bag Store since 1996.\n\n_Online se Sasta Offline Store!_\n\nHow can I help you today?`,
    hindi:   `*Chanakya – The Bag Studio* में आपका स्वागत है! 🎒\nवडोदरा का नंबर 1 बैग स्टोर — 1996 से।\n\n_Online se Sasta Offline Store!_\n\nआज मैं आपकी कैसे मदद कर सकता हूँ?`,
    gujarati:`*Chanakya – The Bag Studio* માં આપનું સ્વાગત છે! 🎒\nવડોદરાનો નં. 1 બેગ સ્ટોર — 1996 થી.\n\n_Online se Sasta Offline Store!_\n\nઆજે હું આપની કેવી મદદ કરી શકું?`,
  },

  menu_more_options: {
    english: `Here are more options — tap below:\n\n_By using this bot you accept our Terms. Type *terms* anytime to read them._`,
    hindi:   `और विकल्प — नीचे टैप करें:\n\n_इस bot का उपयोग करके आप हमारी Terms स्वीकार करते हैं। कभी भी *terms* टाइप करके पढ़ें।_`,
    gujarati:`વધુ વિકલ્પો — નીચે ટૅપ કરો:\n\n_આ bot વાપરીને તમે અમારી Terms સ્વીકારો છો. ગમે ત્યારે *terms* ટાઈપ કરીને વાંચો._`,
  },

  // ── Terms & Conditions ──
  terms_summary: {
    english:
      `📜 *Our Terms & Conditions — Quick Summary*\n\n` +
      `🔧 *Repairs*\n` +
      `• Booking here = ticket only. Real repair starts after you drop the bag in store.\n` +
      `• We inspect and share a *quotation* — *repair begins only after you approve it.* If any extra cost comes up during the repair, we take your *consent first.*\n` +
      `• We hold ready bags free for *30 days*; storage fee after that; disposal after ~4 months.\n` +
      `• *Empty pockets* before drop-off — we aren't responsible for items left inside.\n` +
      `• Free guarantee repairs: weekdays only. Paid repairs: all 7 days.\n\n` +
      `🛡️ *Warranty / Guarantee*\n` +
      `• *Invoice is mandatory* to claim — a clear *soft copy* is accepted if you don't have the physical one. Without it, we can't process a claim.\n` +
      `• *We do not store* your invoice or warranty card — please keep them safe.\n` +
      `• Bags: 12-month cover for *zip alignment & basic stitching*; tears, new zips & other work are chargeable.\n\n` +
      `🛍️ *Purchases & Returns*\n` +
      `• Returns depend on the *brand* — confirm at the time of purchase.\n` +
      `• Returns are issued as *Chanakya store credit ONLY* (12 months validity). No cash or bank-account refunds — ever.\n\n` +
      `🤝 *Custom-printed bulk orders*\n` +
      `• We print *one sample* first; bulk printing only after your written approval.\n` +
      `• We respond to bulk enquiries within *18 hours.* Printing is by a third-party vendor.\n\n` +
      `⏰ *Store hours:* 10 AM – 9 PM (Mon–Sun)\n` +
      `🔒 *Privacy:* We collect only what's needed and don't sell your data.\n\n` +
      `{{terms_link_line}}`,
    hindi:
      `📜 *हमारी Terms & Conditions — संक्षिप्त सारांश*\n\n` +
      `🔧 *रिपेयर*\n` +
      `• यहाँ बुकिंग सिर्फ टिकट बनाती है। असली रिपेयर तब शुरू होगी जब आप बैग दुकान पर लाएँगे।\n` +
      `• हम जाँच करके *कोटेशन* देंगे — *आपकी मंज़ूरी के बाद ही रिपेयर शुरू होगी।* रिपेयर के दौरान कोई अतिरिक्त खर्च आए तो पहले *आपकी सहमति* लेंगे।\n` +
      `• तैयार बैग *30 दिन* तक मुफ्त रखेंगे; उसके बाद storage charge; ~4 महीने बाद disposal।\n` +
      `• ड्रॉप-ऑफ से पहले बैग *खाली* कर लें — अंदर रखी चीज़ों की ज़िम्मेदारी नहीं।\n` +
      `• मुफ्त गारंटी रिपेयर: सिर्फ weekdays। Paid रिपेयर: सातों दिन।\n\n` +
      `🛡️ *वारंटी / गारंटी*\n` +
      `• क्लेम के लिए *इनवॉइस ज़रूरी* — फिज़िकल न हो तो साफ *soft copy* चलेगी। इसके बिना क्लेम नहीं हो सकता।\n` +
      `• हम आपका इनवॉइस/वारंटी कार्ड *स्टोर नहीं करते* — कृपया संभालकर रखें।\n` +
      `• बैग: *zip alignment और basic stitching* पर 12 महीने कवर; tear, नया zip व अन्य काम chargeable।\n\n` +
      `🛍️ *खरीदारी और रिटर्न*\n` +
      `• Return policy *brand* पर निर्भर — खरीदते समय confirm करें।\n` +
      `• Return सिर्फ *Chanakya store credit* के रूप में (12 महीने validity)। Cash या bank refund — कभी नहीं।\n\n` +
      `🤝 *Custom-printed bulk orders*\n` +
      `• पहले *एक सैंपल* प्रिंट होगा; आपकी लिखित approval के बाद ही bulk प्रिंटिंग।\n` +
      `• बल्क enquiry का जवाब *18 घंटे* में। प्रिंटिंग third-party vendor द्वारा।\n\n` +
      `⏰ *स्टोर समय:* सुबह 10 – रात 9 (सोम–रवि)\n` +
      `🔒 *Privacy:* केवल ज़रूरी जानकारी रखते हैं, data नहीं बेचते।\n\n` +
      `{{terms_link_line}}`,
    gujarati:
      `📜 *અમારી Terms & Conditions — ટૂંકો સારાંશ*\n\n` +
      `🔧 *રિપેર*\n` +
      `• અહીં બુકિંગ માત્ર ટિકિટ બનાવે છે. અસલી રિપેર બેગ સ્ટોર પર પહોંચ્યા પછી શરૂ થાય.\n` +
      `• અમે ચકાસીને *કોટેશન* આપીશું — *તમારી મંજૂરી પછી જ રિપેર શરૂ થશે.* રિપેર દરમિયાન કોઈ વધારાનો ખર્ચ આવે તો પહેલા *તમારી સંમતિ* લઈશું.\n` +
      `• તૈયાર બેગ *30 દિવસ* સુધી મફત રાખીશું; પછી storage fee; ~4 મહિના પછી disposal.\n` +
      `• ડ્રોપ-ઓફ પહેલા બેગ *ખાલી* કરો — અંદર રાખેલી વસ્તુઓની જવાબદારી નથી.\n` +
      `• મફત ગૅરંટી રિપેર: માત્ર weekdays. Paid રિપેર: બધા 7 દિવસ.\n\n` +
      `🛡️ *વૉરંટી / ગૅરંટી*\n` +
      `• ક્લેમ માટે *ઇનવૉઇસ ફરજિયાત* — ફિઝિકલ ન હોય તો ચોખ્ખી *soft copy* ચાલશે. એના વગર ક્લેમ થઈ શકે નહીં.\n` +
      `• અમે તમારું ઇનવૉઇસ/વૉરંટી કાર્ડ *સ્ટોર કરતા નથી* — કૃપા કરીને સાચવો.\n` +
      `• બેગ: *zip alignment અને basic stitching* પર 12 મહિના કવર; tear, નવો zip અને બીજું કામ chargeable.\n\n` +
      `🛍️ *ખરીદી અને રિટર્ન*\n` +
      `• Return policy *brand* પ્રમાણે — ખરીદતી વખતે ખાતરી કરો.\n` +
      `• Return માત્ર *Chanakya store credit* તરીકે (12 મહિના validity). Cash કે bank refund — ક્યારેય નહીં.\n\n` +
      `🤝 *Custom-printed bulk orders*\n` +
      `• પહેલા *એક સેમ્પલ* પ્રિન્ટ થશે; તમારી લેખિત મંજૂરી પછી જ bulk printing.\n` +
      `• બલ્ક enquiryનો જવાબ *18 કલાક*માં. Printing third-party vendor દ્વારા.\n\n` +
      `⏰ *સ્ટોર સમય:* સવારે 10 – રાત 9 (સોમ–રવિ)\n` +
      `🔒 *Privacy:* માત્ર જરૂરી માહિતી રાખીએ છીએ, data વેચતા નથી.\n\n` +
      `{{terms_link_line}}`,
  },

  // ── 1-line T&C reminders shown after critical confirmations ──
  terms_reminder_repair: {
    english: `_📜 By submitting this repair ticket you accept our Terms (drop-off in store, 30-day free holding, items inside not our responsibility). Type *terms* anytime to read them._`,
    hindi:   `_📜 यह रिपेयर टिकट जमा करके आप हमारी Terms स्वीकार करते हैं (बैग स्टोर पर लाना, 30 दिन मुफ्त holding, अंदर रखी चीज़ें जिम्मेदारी नहीं)। कभी भी *terms* टाइप करके पढ़ें।_`,
    gujarati:`_📜 આ રિપેર ટિકિટ સબમિટ કરીને તમે અમારી Terms સ્વીકારો છો (બેગ સ્ટોર પર લાવવી, 30 દિવસ મફત holding, અંદર રાખેલી વસ્તુઓની જવાબદારી નથી). ગમે ત્યારે *terms* ટાઈપ કરીને વાંચો._`,
  },

  // Short caption sent alongside the T&Cs PDF that auto-attaches on the very
  // first main menu of every fresh session.
  terms_doc_caption: {
    english: `📜 *Our Terms & Conditions*\n\nHere's a copy of our T&Cs — repair terms, guarantee details, returns (store credit only, no cash refunds), privacy, and grievance contact.\n\n_By using this bot / our stores you accept these terms._`,
    hindi:   `📜 *हमारी Terms & Conditions*\n\nहमारी T&Cs की एक copy — रिपेयर terms, guarantee, returns (सिर्फ store credit, cash refund नहीं), privacy, grievance संपर्क।\n\n_इस bot / हमारे store का उपयोग करके आप इन terms को स्वीकार करते हैं।_`,
    gujarati:`📜 *અમારી Terms & Conditions*\n\nઅમારી T&Cs ની એક copy — રિપેર terms, ગૅરંટી, returns (માત્ર store credit, cash refund નહીં), privacy, grievance સંપર્ક.\n\n_આ bot / અમારા store નો ઉપયોગ કરીને તમે આ terms સ્વીકારો છો._`,
  },

  terms_doc_filename: {
    english: `Chanakya_Terms_and_Conditions.pdf`,
    hindi:   `Chanakya_Terms_and_Conditions.pdf`,
    gujarati:`Chanakya_Terms_and_Conditions.pdf`,
  },

  terms_reminder_corporate: {
    english: `_📜 By submitting this enquiry you accept our Terms. *Custom printing requires sample approval before bulk run* (printed by our third-party vendor).{{terms_url_suffix}}_`,
    hindi:   `_📜 यह enquiry जमा करके आप हमारी Terms स्वीकार करते हैं। *Custom printing के लिए bulk से पहले sample approval ज़रूरी* (third-party vendor द्वारा प्रिंट).{{terms_url_suffix}}_`,
    gujarati:`_📜 આ enquiry સબમિટ કરીને તમે અમારી Terms સ્વીકારો છો. *Custom printing માટે bulk પહેલા sample approval જરૂરી* (third-party vendor દ્વારા પ્રિન્ટ).{{terms_url_suffix}}_`,
  },

  interactive_choose_next: {
    english: `What would you like to do next?`,
    hindi:   `आगे क्या करना चाहेंगे?`,
    gujarati:`આગળ શું કરવું છે?`,
  },

  ask_name: {
    english: `Sure, I can help with that! 😊\n\nFirst, may I know your *name* please?`,
    hindi:   `बिल्कुल, मैं मदद कर सकता हूँ! 😊\n\nपहले, आपका *नाम* बताइए?`,
    gujarati:`ચોક્કસ, હું મદદ કરી શકીશ! 😊\n\nપ્રથમ, આપનું *નામ* જણાવો?`,
  },

  ask_bag_type: {
    english: `Got it, *{{name}}!* 👍\n\nWhat type of bag needs repair?`,
    hindi:   `समझ गया, *{{name}}!* 👍\n\nकिस तरह का बैग रिपेयर करवाना है?`,
    gujarati:`સમજ્યો, *{{name}}!* 👍\n\nકયા પ્રકારની બેગ રિપેર કરવી છે?`,
  },

  ask_problem: {
    english: `*{{bagType}}* noted. What's the problem with it?`,
    hindi:   `*{{bagType}}* नोट किया। उसमें क्या समस्या है?`,
    gujarati:`*{{bagType}}* નોંધ કર્યું. તેમાં શું સમસ્યા છે?`,
  },

  ask_photo: {
    english: `Got it! Now please *send a photo* of your bag, clearly showing the damaged area. 📸`,
    hindi:   `ठीक है! अब कृपया अपने बैग की *फोटो भेजें*, जिसमें खराब हिस्सा साफ दिखे। 📸`,
    gujarati:`સારું! હવે કૃપા કરીને આપની બેગની *ફોટો મોકલો*, જેમાં ખામી સ્પષ્ટ દેખાય. 📸`,
  },

  photo_received: {
    english: `Photo received! ✅\n\nWhich store will you bring the bag to?\n\n📍 *Alkapuri* — Race Course Road\n📍 *Sursagar* — Opp. Pratap Talkies`,
    hindi:   `फोटो मिल गई! ✅\n\nआप बैग किस स्टोर पर लाएंगे?\n\n📍 *Alkapuri* — Race Course Road\n📍 *Sursagar* — Pratap Talkies के सामने`,
    gujarati:`ફોટો મળી! ✅\n\nઆપ બેગ કયા સ્ટોર પર લઈ આવશો?\n\n📍 *Alkapuri* — Race Course Road\n📍 *Sursagar* — Pratap Talkies સામે`,
  },

  repair_confirmed: {
    english: `✅ *Repair Request Confirmed!*\n\n🎫 *Ticket ID:* {{ticketId}}\n👜 *Bag:* {{bagType}}\n🔧 *Problem:* {{problem}}\n🏪 *Bring to:* {{store}}\n\n📋 *Next step:* Please bring your bag to *{{store}}* at your convenience (10 AM – 9 PM, Mon–Sun). Our team will inspect it and share a quotation — *repair work begins only after you approve the quote.*\n\n_Save your Ticket ID! Track anytime:_\n*TRACK {{ticketId}}*`,
    hindi:   `✅ *रिपेयर अनुरोध पक्का हो गया!*\n\n🎫 *टिकट ID:* {{ticketId}}\n👜 *बैग:* {{bagType}}\n🔧 *समस्या:* {{problem}}\n🏪 *स्टोर:* {{store}}\n\n📋 *अगला कदम:* कृपया अपनी सुविधा अनुसार बैग *{{store}}* पर ले आएं (सुबह 10 – रात 9, सोम–रवि)। हमारी टीम जांच करके कोटेशन देगी — *आपकी मंज़ूरी के बाद ही रिपेयर शुरू होगी।*\n\n_अपना Ticket ID सेव करें! ट्रैक करें:_\n*TRACK {{ticketId}}*`,
    gujarati:`✅ *રિપેર વિનંતી પક્કી થઈ!*\n\n🎫 *ટિકિટ ID:* {{ticketId}}\n👜 *બેગ:* {{bagType}}\n🔧 *સમસ્યા:* {{problem}}\n🏪 *સ્ટોર:* {{store}}\n\n📋 *આગળનું પગલું:* કૃપા કરીને આપની અનુકૂળતાએ બેગ *{{store}}* પર લઈ આવો (સવારે 10 – રાત 9, સોમ–રવિ). અમારી ટીમ ચકાસીને કોટેશન આપશે — *આપની મંજૂરી પછી જ રિપેર શરૂ થશે.*\n\n_ટિકિટ ID સાચવો! ટ્રૅક કરો:_\n*TRACK {{ticketId}}*`,
  },

  track_ask_id: {
    english: `Please enter your *Ticket ID* to track your repair.\n\nYou can paste the whole line from your confirmation (e.g. *TRACK cha-2026-0042*) — *capital letters are optional*.`,
    hindi:   `अपना *Ticket ID* डालें ताकि रिपेयर track हो सके।\n\nकन्फर्मेशन मैसेज से पूरी लाइन paste करें (जैसे *TRACK cha-2026-0042*) — *बड़े-छोटे अक्षर से फर्क नहीं पड़ता*।`,
    gujarati:`આપનો *Ticket ID* દાખલ કરો, રિપેર ટ્રૅક કરવા.\n\nકન્ફર્મેશન મેસેજની આખી લાઈન પેસ્ટ કરો (દા.ત. *TRACK cha-2026-0042*) — *મોટા-નાના અક્ષરથી ફરક નથી પડતો.*`,
  },

  track_not_found: {
    english: `Sorry, I couldn't find a ticket with ID *{{id}}*. 🔍\n\nPlease check the ID and try again. For help call:\n${defaultCallLine()}`,
    hindi:   `माफ़ कीजिए, *{{id}}* ID वाला टिकट नहीं मिला। 🔍\n\nID जांचकर दोबारा कोशिश करें। मदद के लिए:\n${defaultCallLine()}`,
    gujarati:`માફ કરો, *{{id}}* ID વાળી ટિકિટ મળી નહીં. 🔍\n\nID ચકાસીને ફરી પ્રયાસ કરો. મદદ માટે:\n${defaultCallLine()}`,
  },

  /** Default sheet row + outbound push when pending physical drop-off */
  status_physical_pending: {
    english: `📋 *{{ticketId}}*\n\nYour ticket is ready and waiting — the only thing missing is the bag itself! 🎒\n\nOur repair bench at *{{store}}* is holding a spot for it. Drop it off any day, *10 AM – 9 PM*, and we'll get started with an inspection and quote.`,
    hindi:   `📋 *{{ticketId}}*\n\nआपका टिकट तैयार है — बस अब बैग का इंतज़ार है! 🎒\n\n*{{store}}* पर हमारी रिपेयर टीम ने इसके लिए जगह रखी है। किसी भी दिन *सुबह 10 – रात 9* बजे तक ले आएं — जांच और कोटेशन तुरंत शुरू करेंगे।`,
    gujarati:`📋 *{{ticketId}}*\n\nઆપની ટિકિટ તૈયાર છે — હવે ફક્ત બેગની જ રાહ છે! 🎒\n\n*{{store}}* પર અમારી રિપેર ટીમે એના માટે જગ્યા રાખી છે. કોઈ પણ દિવસે *સવારે 10 – રાત 9* સુધી લઈ આવો — ચકાસણી અને કોટેશન તરત શરૂ કરીશું.`,
  },

  /** Any non-standard wording staff chose — still notifies via poller/track.
   * NB: never promise a button here — buttons arrive as a separate message and
   * can fail independently; typed commands (*track* / *menu*) always work. */
  status_poller_generic: {
    english: `🔔 *Repair update*\n\n🎫 *Ticket:* {{ticketId}}\n📊 *Current status:*\n{{status}}\n🏪 *Store:* {{store}}\n\nReply *track* anytime for full details, or *menu* for the main menu.`,
    hindi:   `🔔 *रिपेयर अपडेट*\n\n🎫 *टिकट:* {{ticketId}}\n📊 *वर्तमान स्थिति:*\n{{status}}\n🏪 *स्टोर:* {{store}}\n\nपूरी जानकारी के लिए कभी भी *track* लिखें, या *menu* लिखकर मुख्य मेनू खोलें।`,
    gujarati:`🔔 *રિપેર અપડેટ*\n\n🎫 *ટિકિટ:* {{ticketId}}\n📊 *સ્ટેટસ:*\n{{status}}\n🏪 *સ્ટોર:* {{store}}\n\nપૂરી વિગત માટે ગમે ત્યારે *track* લખો, અથવા *menu* લખીને મુખ્ય મેનુ ખોલો.`,
  },

  status_bag_received: {
    english: `🔵 *Status Update — {{ticketId}}*\n\nYour bag has been *received* at {{store}}.\nOur team will inspect it and contact you with the repair cost within 24 hours.`,
    hindi:   `🔵 *स्थिति अपडेट — {{ticketId}}*\n\nआपका बैग {{store}} पर *मिल गया* है।\nहमारी टीम 24 घंटे में निरीक्षण करके आपको कीमत बताएगी।`,
    gujarati:`🔵 *સ્ટેટસ અપડેટ — {{ticketId}}*\n\nઆપની બેગ {{store}} પર *પ્રાપ્ત* થઈ છે.\nઅમારી ટીમ 24 કલાકમાં ચકાસીને ભાવ જણાવશે.`,
  },

  status_inspection_done: {
    english: `🟡 *Status Update — {{ticketId}}*\n\nInspection *complete!* The repair cost is being finalized.\nYou'll receive the quote very shortly.`,
    hindi:   `🟡 *स्थिति अपडेट — {{ticketId}}*\n\nनिरीक्षण *पूरा हुआ!* मरम्मत की लागत तय की जा रही है।\nआपको जल्द ही कोटेशन मिलेगी।`,
    gujarati:`🟡 *સ્ટેટસ અપડેટ — {{ticketId}}*\n\nચકાસણી *પૂર્ણ!* રિપેરનો ખર્ચ નક્કી થઈ રહ્યો છે.\nટૂંક સમયમાં ભાવ મળશે.`,
  },

  status_repair_in_progress: {
    english: `🔨 *Status Update — {{ticketId}}*\n\nGreat news! Your bag is currently being *repaired* by our experts. 💪\nWe'll notify you the moment it's ready!`,
    hindi:   `🔨 *स्थिति अपडेट — {{ticketId}}*\n\nखुशखबरी! आपका बैग हमारे विशेषज्ञों द्वारा *मरम्मत* हो रहा है। 💪\nतैयार होते ही सूचित करेंगे!`,
    gujarati:`🔨 *સ્ટેટસ અપડેટ — {{ticketId}}*\n\nખુશીના સમાચાર! આપની બેગ અમારા નિષ્ણાતો દ્વારા *રિપેર* થઈ રહી છે. 💪\nતૈયાર થતાંની સાથે જ જાણ કરીશું!`,
  },

  status_ready_pickup: {
    english: `🟢 *Your bag is READY for Pickup!* 🎉\n\n🎫 Ticket: *{{ticketId}}*\n🏪 Store: *{{store}}*\n⏰ Timings: 10 AM – 9 PM (Mon–Sun)\n\n{{afterPhotoText}}\n\n_Please bring this message when you collect your bag._`,
    hindi:   `🟢 *आपका बैग PICKUP के लिए READY है!* 🎉\n\n🎫 टिकट: *{{ticketId}}*\n🏪 स्टोर: *{{store}}*\n⏰ समय: सुबह 10 – रात 9 (सोम–रवि)\n\n{{afterPhotoText}}\n\n_बैग लेते समय यह मैसेज साथ लाएं।_`,
    gujarati:`🟢 *આપની બેગ Pickup માટે READY છે!* 🎉\n\n🎫 ટિકિટ: *{{ticketId}}*\n🏪 સ્ટોર: *{{store}}*\n⏰ સમય: સવારે 10 – રાત 9 (સોમ–રવિ)\n\n{{afterPhotoText}}\n\n_બેગ લેવા સમયે આ મેસેજ સાથે લાવજો._`,
  },

  status_cannot_repair: {
    english: `😔 *Status Update — {{ticketId}}*\n\nAfter thorough inspection, unfortunately this damage *cannot be repaired*.\n\nPlease visit *{{store}}* to collect your bag.\nWe apologize for the inconvenience.\n\nFor questions: ${defaultCallLine()}`,
    hindi:   `😔 *स्थिति अपडेट — {{ticketId}}*\n\nपूरी जांच के बाद, दुर्भाग्य से यह क्षति *ठीक नहीं हो सकती।*\n\nकृपया अपना बैग लेने *{{store}}* पर आएं।\nअसुविधा के लिए खेद है।\n\n${defaultCallLine()}`,
    gujarati:`😔 *સ્ટેટસ અપડેટ — {{ticketId}}*\n\nસંપૂર્ણ ચકાસણી પછી, દુ:ખ સાથે જણાવવાનું કે *આ નુકસાન રિપેર થઈ શકે એમ નથી.*\n\nઆપની બેગ લેવા *{{store}}* પર આવો.\nઅસુવિધા બદલ ક્ષમા કરશો.\n\n${defaultCallLine()}`,
  },

  status_no_change_reassurance: {
    english:
      `💛 *Quick update — {{ticketId}}*\n\nYour repair is still showing as: *{{status}}*\n🏪 *Store:* {{store}}\n📅 *ETA (if set):* {{estimatedPickup}}\n\nWe're on it — sometimes the sheet doesn’t change for a day while work continues. If anything feels off, reply here or call us.\n${defaultCallLine()}`,
    hindi:
      `💛 *जल्दी अपडेट — {{ticketId}}*\n\nआपकी रिपेयर स्थिति अब भी: *{{status}}*\n🏪 *स्टोर:* {{store}}\n📅 *ETA:* {{estimatedPickup}}\n\nकाम जारी है — कभी-कभी शीट 1 दिन तक अपडेट नहीं होती जबकि काम चल रहा हो। किसी भी सवाल के लिए यहाँ रिप्लाई करें या कॉल करें।\n${defaultCallLine()}`,
    gujarati:
      `💛 *ટૂંકો અપડેટ — {{ticketId}}*\n\nઆપની રિપેરની સ્થિતિ હજુ: *{{status}}*\n🏪 *સ્ટોર:* {{store}}\n📅 *ETA:* {{estimatedPickup}}\n\nઅમે કામ કરી રહ્યા છીએ — ક્યારેક એક દિવસ સુધી શીટ અપડેટ ન થાય ત્યારે પણ કામ ચાલતું હોય છે. કોઈ પ્રશ્ન હોય તો અહીં જવાબ આપો અથવા કૉલ કરો.\n${defaultCallLine()}`,
  },

  store_intro: {
    english: `🗺️ *Our Stores — Chanakya Bag Studio*\n\nWe have *2 stores* in Vadodara.\n⏰ *10 AM – 9 PM* (Mon – Sun)\n\nPick a store below — we’ll open *Google Maps driving directions* to that door.`,
    hindi:   `🗺️ *हमारे स्टोर — Chanakya Bag Studio*\n\nवडोदरा में *2 स्टोर।*\n⏰ *सुबह 10 – रात 9* (सोम – रवि)\n\nनीचे स्टोर चुनें — *Google Maps दिशा–निर्देश* खुलेंगे।`,
    gujarati:`🗺️ *અમારા સ્ટોર — Chanakya Bag Studio*\n\nવડોદરામાં *2 સ્ટોર.*\n⏰ *સવારે 10 – રાત 9* (સોમ–રવિ)\n\nનીચે સ્ટોર પસંદ કરો — *Google Maps દિશા* ખુલશે.`,
  },

  store_pick_directions: {
    english: `Which store do you need directions to?`,
    hindi:   `किस स्टोर के लिए दिशा चाहिए?`,
    gujarati:`કયા સ્ટોરની દિશા જોઈએ?`,
  },

  store_directions_cta: {
    english: `🚗 *Driving directions — {{storeName}}*\n\nOpen in Google Maps (turn-by-turn from your location):\n{{url}}\n\n_We’ll also pin the exact storefront below — open the pin in Maps anytime._`,
    hindi:   `🚗 *ड्राइविंग दिशा — {{storeName}}*\n\nGoogle Maps में खोलें (आपकी लोकेशन से नेविगेशन):\n{{url}}\n\n_नीचे सटीक पिन भी है — Maps में खोल सकते हैं।_`,
    gujarati:`🚗 *ડ્રાઈવિંગ દિશા — {{storeName}}*\n\nGoogle Maps ખોલો (તમારી લોકેશનથી નેવિગેશન):\n{{url}}\n\n_નીચે ચોખ્ખું પિન પણ છે — Mapsમાં ગમે ત્યારે ખોલી શકાય._`,
  },

  corporate_intro: {
    english: `🤝 *Corporate & Bulk Orders*\n\nWe supply bags in bulk to schools, companies, hospitals, and more!\n\nCustom printing available. Let me collect some details to give you the best quote.`,
    hindi:   `🤝 *कॉर्पोरेट और बल्क ऑर्डर*\n\nहम स्कूल, कंपनी, अस्पताल और अन्य संस्थानों को बल्क में बैग सप्लाई करते हैं!\n\nकस्टम प्रिंटिंग उपलब्ध है। मुझे कुछ जानकारी दें ताकि मैं आपको सर्वोत्तम कोटेशन दे सकूं।`,
    gujarati:`🤝 *કૉર્પોરેટ અને બલ્ક ઓર્ડર*\n\nઅમે શાળા, કંપની, હૉસ્પિટલ અને બીજે પણ બલ્કમાં બેગ સપ્લાય કરીએ છીએ!\n\nકસ્ટમ પ્રિન્ટિંગ ઉપલબ્ધ છે. શ્રેષ્ઠ ભાવ આપવા માટે મને થોડી વિગતો જણાવો.`,
  },

  corporate_ask_company: {
    english: `What is your *company/school/organization name?*`,
    hindi:   `आपकी *कंपनी/स्कूल/संस्था का नाम* क्या है?`,
    gujarati:`આપની *કંપની/શાળા/સંસ્થાનું નામ* શું છે?`,
  },

  corporate_ask_product: {
    english: `What type of bags do you need?\n\n_e.g. School bags, Laptop bags, Travelling bags, Handbags, Corporate gift bags, Custom printed bags_`,
    hindi:   `आपको किस तरह के बैग चाहिए?\n\n_जैसे: स्कूल बैग, लैपटॉप बैग, ट्रैवलिंग बैग, हैंडबैग, कॉर्पोरेट गिफ्ट बैग_`,
    gujarati:`આપને કયા પ્રકારની બેગ જોઈએ?\n\n_દા.ત. સ્કૂલ બેગ, લૅપટૉપ બેગ, ટ્રાવેલ બેગ, હૅન્ડબેગ, કૉર્પોરેટ ગિફ્ટ બેગ_`,
  },

  corporate_ask_quantity: {
    english: `Approximately how many bags do you need?`,
    hindi:   `आपको लगभग कितने बैग चाहिए?`,
    gujarati:`આપને લગભગ કેટલી બેગ જોઈએ?`,
  },

  corporate_ask_branding: {
    english: `Do you need *custom printing/branding* on the bags?\n\n_e.g., company logo, school name_`,
    hindi:   `क्या बैग पर *कस्टम प्रिंटिंग/ब्रांडिंग* चाहिए?\n\n_जैसे: कंपनी लोगो, स्कूल का नाम_`,
    gujarati:`શું બેગ પર *કસ્ટમ પ્રિન્ટિંગ/બ્રૅન્ડિંગ* જોઈએ?\n\n_દા.ત. કંપનીનો લૉગો, શાળાનું નામ_`,
  },

  corporate_confirmed: {
    english: `✅ *Enquiry Received!*\n\nThank you *{{name}}* from *{{company}}!*\n\nWe'll contact you within *18 hours* with a custom quote.\n\nFor urgent orders:\n${directoryWithEmail()}`,
    hindi:   `✅ *इन्क्वायरी मिली!*\n\n*{{company}}* से *{{name}}* जी, धन्यवाद!\n\n*18 घंटे* में हम आपसे कस्टम कोटेशन के साथ संपर्क करेंगे।\n\nअर्जेंट ऑर्डर:\n${directoryWithEmail()}`,
    gujarati:`✅ *એન્ક્વાયરી મળી!*\n\n*{{company}}* થી *{{name}}*, આભાર!\n\n*18 કલાક*માં અમે કસ્ટમ કોટેશન સાથે આપનો સંપર્ક કરીશું.\n\nઅર્જન્ટ ઓર્ડર માટે:\n${directoryWithEmail()}`,
  },

  escalate_message: {
    english: `Sure! Connecting you to our team. 👋\n\nYou can reach us directly:\n\n${directoryWithEmail()}\n\n⏰ Available: 10 AM – 9 PM\n\nType *menu* anytime to restart the chatbot.`,
    hindi:   `बिल्कुल! आपको हमारी टीम से जोड़ रहे हैं। 👋\n\nसीधे संपर्क करें:\n\n${directoryWithEmail()}\n\n⏰ समय: सुबह 10 बजे – रात 9 बजे\n\nचैटबॉट दोबारा शुरू करने के लिए *menu* टाइप करें।`,
    gujarati:`ચોક્કસ! તમને અમારી ટીમ સાથે જોડી રહ્યા છીએ. 👋\n\nસીધો સંપર્ક કરો:\n\n${directoryWithEmail()}\n\n⏰ સમય: સવારે 10 – રાત 9\n\nચેટબોટ ફરીથી શરૂ કરવા *menu* ટાઇપ કરો.`,
  },

  fallback_once: {
    english: `Sorry, I didn't quite get that. 😅\n\nPlease choose one of the options below:`,
    hindi:   `माफ़ कीजिए, मैं समझ नहीं पाया। 😅\n\nनीचे दिए विकल्पों में से एक चुनें:`,
    gujarati:`માફ કરો, હું બરાબર સમજી શક્યો નહીં. 😅\n\nનીચે આપેલા વિકલ્પોમાંથી એક પસંદ કરો:`,
  },

  fallback_offer_human: {
    english: `It seems I'm having trouble understanding. 😊\n\nWould you like to talk to a person from our team?`,
    hindi:   `लगता है मुझे समझने में परेशानी हो रही है। 😊\n\nक्या आप हमारी टीम के किसी व्यक्ति से बात करना चाहेंगे?`,
    gujarati:`લાગે છે કે મને સમજવામાં તકલીફ થાય છે. 😊\n\nશું તમે અમારી ટીમના કોઈ વ્યક્તિ સાથે વાત કરવા માગો છો?`,
  },

  flow_reminder: {
    english: `👋 Hi! You were in the middle of something — just reply here to continue, or type *menu* to start over.`,
    hindi:   `👋 नमस्ते! आप कुछ बीच में छोड़ गए — जारी रखने के लिए यहीं जवाब दें, या *menu* लिखकर नए सिरे से शुरू करें।`,
    gujarati:`👋 કેમ છો! તમે કંઈક વચ્ચે છોડ્યું હતું — ચાલુ રાખવા અહીં જ જવાબ આપો, અથવા *menu* લખીને નવેસરથી શરૂ કરો.`,
  },

  pickup_reminder: {
    english: `👋 Reminder from *Chanakya Bag Studio!*\n\nYour repaired bag *(Ticket: {{ticketId}})* has been ready for *{{days}} days* at *{{store}}.*\n\nPlease collect at your earliest.\n⏰ Store: 10 AM – 9 PM daily\n${defaultCallLine()}`,
    hindi:   `👋 *Chanakya Bag Studio* से अनुस्मारक!\n\nआपका रिपेयर किया हुआ बैग *(टिकट: {{ticketId}})* पिछले *{{days}} दिनों* से *{{store}}* में तैयार है।\n\nकृपया जल्द लेने आएं।\n⏰ स्टोर: सुबह 10 – रात 9\n${defaultCallLine()}`,
    gujarati:`👋 *Chanakya Bag Studio* તરફથી યાદ અપાવીએ છીએ!\n\nઆપની રિપેર થયેલી બેગ *(ટિકિટ: {{ticketId}})* પાછલા *{{days}} દિવસથી* *{{store}}* પર તૈયાર છે.\n\nકૃપા કરીને ટૂંક સમયમાં લઈ આવો.\n⏰ સ્ટોર: સવારે 10 – રાત 9\n${defaultCallLine()}`,
  },

  // ── Common UI strings used across flows ──
  // (Centralised so list headers / button labels translate properly)

  list_header_bag_type: {
    english: `👜 Bag Type`,
    hindi:   `👜 बैग प्रकार`,
    gujarati:`👜 બેગ પ્રકાર`,
  },

  list_header_problem: {
    english: `🔧 Problem`,
    hindi:   `🔧 समस्या`,
    gujarati:`🔧 સમસ્યા`,
  },

  list_section_bag_type: {
    english: `Bag Type`,
    hindi:   `बैग का प्रकार`,
    gujarati:`બેગનો પ્રકાર`,
  },

  list_section_problem: {
    english: `Select Problem`,
    hindi:   `समस्या चुनें`,
    gujarati:`સમસ્યા પસંદ કરો`,
  },

  btn_select_short: {
    english: `Select`,
    hindi:   `चुनें`,
    gujarati:`પસંદ કરો`,
  },

  btn_main_menu_short: {
    english: `🏠 Main Menu`,
    hindi:   `🏠 मुख्य मेनू`,
    gujarati:`🏠 મુખ્ય મેનુ`,
  },

  btn_track_repair_short: {
    english: `📍 Track Repair`,
    hindi:   `📍 ट्रैक करें`,
    gujarati:`📍 ટ્રૅક કરો`,
  },

  contact_for_store: {
    english: `📞 *Contact ({{storeName}}):*\n{{contactBody}}`,
    hindi:   `📞 *संपर्क ({{storeName}}):*\n{{contactBody}}`,
    gujarati:`📞 *સંપર્ક ({{storeName}}):*\n{{contactBody}}`,
  },

  // ── Broadcast opt-out / opt-in (STOP / RESUME keywords) ──
  opt_out_confirmed: {
    english: `✅ Done — you won't receive promotional messages from us anymore.\n\nYou can still use this bot for repairs, tracking, and store info anytime. To get offers again, just type *RESUME*.`,
    hindi:   `✅ हो गया — अब आपको हमारे promotional message नहीं आएंगे।\n\nरिपेयर, ट्रैकिंग और स्टोर जानकारी के लिए bot का उपयोग जारी रख सकते हैं। Offers फिर से चाहिए तो *RESUME* टाइप करें।`,
    gujarati:`✅ થઈ ગયું — હવે તમને અમારા promotional message નહીં આવે.\n\nરિપેર, ટ્રૅકિંગ અને સ્ટોર માહિતી માટે bot ગમે ત્યારે વાપરી શકો છો. Offers ફરી જોઈએ તો *RESUME* ટાઈપ કરો.`,
  },

  opt_in_confirmed: {
    english: `✅ Welcome back! You'll now receive our offers and updates again.\n\nType *STOP* anytime to unsubscribe.`,
    hindi:   `✅ स्वागत है! अब आपको हमारे offers और updates फिर से मिलेंगे।\n\nकभी भी unsubscribe करने के लिए *STOP* टाइप करें।`,
    gujarati:`✅ સ્વાગત છે! હવે તમને અમારા offers અને updates ફરી મળશે.\n\nUnsubscribe કરવા ગમે ત્યારે *STOP* ટાઈપ કરો.`,
  },

  /** Appended to opt_out_confirmed when the customer still has an open,
   *  opted-in repair ticket — bare STOP only stops marketing, so we say so
   *  plainly rather than letting them assume all messages have stopped. */
  opt_out_repair_still_on: {
    english: `\n\n🔧 Note: you'll still get updates on your open repair ticket. Reply *stop updates* if you'd like those turned off too.`,
    hindi:   `\n\n🔧 ध्यान दें: आपकी चालू रिपेयर टिकट के अपडेट आते रहेंगे। वे भी बंद करने हों तो *अपडेट बंद* भेजें।`,
    gujarati:`\n\n🔧 નોંધ: તમારી ચાલુ રિપેર ટિકિટના અપડેટ આવતા રહેશે. એ પણ બંધ કરવા હોય તો *અપડેટ બંધ* મોકલો.`,
  },

  // ── Language selection (persisted per phone) ──
  /** First-contact picker. Deliberately shows all three languages at once —
   *  we don't yet know which one they read. */
  language_pick: {
    english: `🙏 Welcome to *Chanakya – The Bag Studio!*\n\nPlease choose your language:\nकृपया अपनी भाषा चुनें:\nકૃપા કરીને તમારી ભાષા પસંદ કરો:`,
    hindi:   `🙏 Welcome to *Chanakya – The Bag Studio!*\n\nPlease choose your language:\nकृपया अपनी भाषा चुनें:\nકૃપા કરીને તમારી ભાષા પસંદ કરો:`,
    gujarati:`🙏 Welcome to *Chanakya – The Bag Studio!*\n\nPlease choose your language:\nकृपया अपनी भाषा चुनें:\nકૃપા કરીને તમારી ભાષા પસંદ કરો:`,
  },

  language_saved: {
    english: `✅ Language set to *English*. You can change it anytime by typing *language*.`,
    hindi:   `✅ भाषा *हिंदी* चुनी गई। कभी भी बदलने के लिए *language* टाइप करें।`,
    gujarati:`✅ ભાષા *ગુજરાતી* પસંદ થઈ. ગમે ત્યારે બદલવા *language* ટાઈપ કરો.`,
  },

  // ── Proactive repair-update opt-in (per ticket) ──
  repair_updates_ask: {
    english: `🔔 Would you like *WhatsApp updates* as your repair progresses?\n\nOr you can simply check anytime yourself by tapping *Track My Repair*.`,
    hindi:   `🔔 क्या आप रिपेयर की प्रगति पर *WhatsApp अपडेट* चाहेंगे?\n\nया आप कभी भी *ट्रैक करें* पर टैप करके खुद देख सकते हैं।`,
    gujarati:`🔔 શું તમે રિપેરની પ્રગતિ પર *WhatsApp અપડેટ* ઈચ્છો છો?\n\nઅથવા તમે ગમે ત્યારે *ટ્રૅક કરો* પર ટૅપ કરીને જાતે જોઈ શકો છો.`,
  },

  repair_updates_on_confirm: {
    english: `✅ Done — we'll message you here as your repair moves forward.\n\nReply *stop updates* anytime to turn these off.`,
    hindi:   `✅ हो गया — रिपेयर आगे बढ़ने पर हम आपको यहीं मैसेज करेंगे।\n\nबंद करने के लिए कभी भी *अपडेट बंद* भेजें।`,
    gujarati:`✅ થઈ ગયું — રિપેર આગળ વધતાં અમે તમને અહીં મેસેજ કરીશું.\n\nબંધ કરવા ગમે ત્યારે *અપડેટ બંધ* મોકલો.`,
  },

  repair_updates_off_confirm: {
    english: `✅ Repair updates turned off. You can still check anytime with *track*, and reply *resume updates* to turn them back on.`,
    hindi:   `✅ रिपेयर अपडेट बंद कर दिए गए। *track* लिखकर कभी भी देख सकते हैं, और *अपडेट चालू* भेजकर दोबारा चालू कर सकते हैं।`,
    gujarati:`✅ રિપેર અપડેટ બંધ કરી દીધા. *track* લખીને ગમે ત્યારે જોઈ શકો છો, અને *અપડેટ ચાલુ* મોકલીને ફરી ચાલુ કરી શકો છો.`,
  },

  // ── Photo, requested AFTER the ticket exists ──
  /** Asked once the ticket is safely created, so it is genuinely optional and
   *  nobody is ever blocked from booking by a bag they don't have to hand. */
  photo_request_after_ticket: {
    english: `📸 One last thing — if your bag is with you, send a *photo* of the damage and we'll add it to your ticket.\n\nNo rush: send it any time before you drop the bag off, or just show us at the counter.`,
    hindi:   `📸 आख़िरी बात — अगर बैग आपके पास है तो नुकसान की *फोटो* भेज दें, हम टिकट में जोड़ देंगे।\n\nजल्दी नहीं: ड्रॉप-ऑफ से पहले कभी भी भेज सकते हैं, या काउंटर पर दिखा दीजिए।`,
    gujarati:`📸 છેલ્લી વાત — જો બેગ તમારી પાસે હોય તો નુકસાનની *ફોટો* મોકલો, અમે ટિકિટમાં ઉમેરી દઈશું.\n\nઉતાવળ નથી: ડ્રોપ-ઓફ પહેલાં ગમે ત્યારે મોકલો, અથવા કાઉન્ટર પર બતાવજો.`,
  },

  photo_attached: {
    english: `✅ Photo added to ticket *{{ticketId}}* — thank you!`,
    hindi:   `✅ फोटो टिकट *{{ticketId}}* में जुड़ गई — धन्यवाद!`,
    gujarati:`✅ ફોટો ટિકિટ *{{ticketId}}* માં ઉમેરાઈ — આભાર!`,
  },

  photo_attach_failed: {
    english: `We received your photo but couldn't save it. No problem — please show it to us when you drop the bag off.`,
    hindi:   `फोटो मिली, पर सेव नहीं हो पाई। कोई बात नहीं — बैग देते समय दिखा दीजिए।`,
    gujarati:`ફોટો મળી, પણ સેવ થઈ શકી નહીં. વાંધો નહીં — બેગ આપતી વખતે બતાવજો.`,
  },

  photo_no_open_ticket: {
    english: `Thanks for the photo! We couldn't find an open repair to attach it to — tap *🔧 Repair My Bag* to book one first.`,
    hindi:   `फोटो के लिए धन्यवाद! जोड़ने के लिए कोई चालू रिपेयर नहीं मिली — पहले *🔧 बैग रिपेयर करें* पर टैप करें।`,
    gujarati:`ફોટો બદલ આભાર! ઉમેરવા માટે કોઈ ચાલુ રિપેર મળી નહીં — પહેલા *🔧 બેગ રિપેર કરો* પર ટૅપ કરો.`,
  },

  // ── Post-service feedback ──
  feedback_thanks: {
    english: `🙏 Thank you for the feedback — it genuinely helps us. We hope to see you again at Chanakya!`,
    hindi:   `🙏 आपकी राय के लिए धन्यवाद — इससे हमें वाकई मदद मिलती है। फिर मिलेंगे Chanakya पर!`,
    gujarati:`🙏 તમારા અભિપ્રાય બદલ આભાર — એનાથી અમને ખરેખર મદદ મળે છે. ફરી મળીશું Chanakya પર!`,
  },

  feedback_thanks_low: {
    english: `🙏 Thank you for telling us — we're sorry it wasn't right.\n\nOur team has been notified and will contact you shortly to put it right.`,
    hindi:   `🙏 बताने के लिए धन्यवाद — खेद है कि अनुभव अच्छा नहीं रहा।\n\nहमारी टीम को सूचित कर दिया गया है, वे जल्द ही संपर्क करेंगे।`,
    gujarati:`🙏 જણાવવા બદલ આભાર — માફ કરશો કે અનુભવ સારો ન રહ્યો.\n\nઅમારી ટીમને જાણ કરી દીધી છે, તેઓ ટૂંક સમયમાં સંપર્ક કરશે.`,
  },

  repair_updates_none_open: {
    english: `You don't have an open repair with us right now, so there are no updates to change. Tap *Repair My Bag* to book one.`,
    hindi:   `अभी आपकी कोई चालू रिपेयर नहीं है, इसलिए बदलने के लिए कोई अपडेट नहीं। नई रिपेयर के लिए *बैग रिपेयर करें* पर टैप करें।`,
    gujarati:`અત્યારે તમારી કોઈ ચાલુ રિપેર નથી, તેથી બદલવા માટે કોઈ અપડેટ નથી. નવી રિપેર માટે *બેગ રિપેર કરો* પર ટૅપ કરો.`,
  },
};

/**
 * Human-readable status text, localised — used both for the {{3}} variable in
 * the repair-status Utility templates and for the ticket-picker row labels.
 * An unrecognised (staff-typed) status falls through verbatim so nothing is
 * ever silently blanked.
 */
const STATUS_LABELS = {
  [DEFAULT_REPAIR_TICKET_STATUS]: {
    english: 'Awaiting drop-off at the store',
    hindi:   'स्टोर पर बैग आने का इंतज़ार',
    gujarati:'સ્ટોર પર બેગ આવવાની રાહ',
  },
  'Bag Received':       { english: 'Bag received at the store', hindi: 'बैग स्टोर पर मिल गया',       gujarati: 'બેગ સ્ટોર પર મળી ગઈ' },
  'Inspection Done':    { english: 'Inspection complete',       hindi: 'जाँच पूरी हुई',              gujarati: 'ચકાસણી પૂર્ણ' },
  'Repair In Progress': { english: 'Repair in progress',        hindi: 'रिपेयर चल रही है',           gujarati: 'રિપેર ચાલુ છે' },
  'Repair Complete':    { english: 'Repair complete',           hindi: 'रिपेयर पूरी हुई',            gujarati: 'રિપેર પૂર્ણ' },
  'Ready for Pickup':   { english: 'Ready for pickup',          hindi: 'पिकअप के लिए तैयार',         gujarati: 'પિકઅપ માટે તૈયાર' },
  'Cannot Repair':      { english: 'Cannot be repaired',        hindi: 'रिपेयर संभव नहीं',           gujarati: 'રિપેર શક્ય નથી' },
  'Picked Up':          { english: 'Collected',                 hindi: 'ले लिया गया',                gujarati: 'લઈ લેવાઈ' },
};

function statusLabel(status, lang) {
  const s = canonicalStatus(status);
  const entry = STATUS_LABELS[s];
  if (entry) return entry[lang] || entry.english;
  return s || '—';
}

function get(key, lang) {
  const langKey = lang || 'english';
  return messages[key]?.[langKey] || messages[key]?.english || `[Missing: ${key}]`;
}

function fill(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] || '');
}

/* ── T&Cs URL helpers ─────────────────────────────────────────────────
 *
 * TERMS_URL can be ANY clickable link — Google Drive share, Cloudinary URL,
 * GitHub raw file, notion page, whatever. Used in text messages.
 *
 * TERMS_DOC_URL is used ONLY for the WhatsApp document attach (must be a
 * host in IMAGE_URL_ALLOWLIST — see src/services/whatsapp.js).
 * If TERMS_URL is blank but TERMS_DOC_URL is set, we use TERMS_DOC_URL for
 * text too. Symmetrically fine.
 *
 * If BOTH are blank, no URL appears anywhere — the bot still ships the
 * terms_summary text and the T&Cs still exist logically.
 */
function termsLinkUrl() {
  const link = (process.env.TERMS_URL || '').trim();
  if (link) return link;
  return (process.env.TERMS_DOC_URL || '').trim();
}

/** Returns the {{terms_link_line}} filler for terms_summary — a full "📄 ..." line
 *  or empty string. */
function termsLinkLine(lang) {
  const url = termsLinkUrl();
  if (!url) return '';
  const labels = {
    english:  '📄 *Full Terms:*',
    hindi:    '📄 *पूरी Terms:*',
    gujarati: '📄 *પૂરી Terms:*',
  };
  return `${labels[lang] || labels.english} ${url}`;
}

/** Returns the {{terms_url_suffix}} filler for the 1-line reminders — a short
 *  " Read: <url>" tail or empty string. Includes a leading space so the
 *  preceding sentence still reads cleanly if empty. */
function termsUrlSuffix(lang) {
  const url = termsLinkUrl();
  if (!url) return '';
  const labels = {
    english:  ' Read:',
    hindi:    ' पढ़ें:',
    gujarati: ' વાંચો:',
  };
  return `${labels[lang] || labels.english} ${url}`;
}

module.exports = {
  get, fill, randomGreeting, termsLinkUrl, termsLinkLine, termsUrlSuffix,
  statusLabel,
};
