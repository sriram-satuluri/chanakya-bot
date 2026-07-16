// Live categories pulled from https://front.chanakyacorporate.com/
// CategoryMaster API (May 2026). The `id` is the MongoDB _id used by the
// website to filter the product list page.
//
// Deep-link URL pattern (sniffed from the bundled JS):
//   https://front.chanakyacorporate.com/product-list?category={id}&categoryName={encodedName}
//
// To refresh: hit GET https://front.chanakyacorporate.com/api/auth/list/CategoryMaster

const CATALOG_SITE = 'https://front.chanakyacorporate.com';

const CATEGORIES = [
  {
    id: '6700f7e77c4f1bb93e48e2d9',
    apiName: 'Travelling Bags',
    english: '🧳 Travelling Bags',
    hindi: '🧳 ट्रॅवल बैग',
    gujarati: '🧳 ટ્રાવેલ બેગ',
  },
  {
    id: '6700f8037c4f1bb93e48e2dc',
    apiName: 'Backpack',
    english: '🎒 Backpacks',
    hindi: '🎒 बैकपैक',
    gujarati: '🎒 બેકપેક',
  },
  {
    id: '6700f8277c4f1bb93e48e2df',
    apiName: 'Office Bags',
    english: '💼 Office Bags',
    hindi: '💼 ऑफिस बैग',
    gujarati: '💼 ઓફિસ બેગ',
  },
  {
    id: '6700f9a17c4f1bb93e48e303',
    apiName: 'Helmet',
    english: '⛑️ Helmets',
    hindi: '⛑️ हेलमेट',
    gujarati: '⛑️ હેલમેટ',
  },
  {
    id: '6700f8427c4f1bb93e48e2e2',
    apiName: 'Accessories',
    english: '👜 Accessories',
    hindi: '👜 एक्सेसरीज़',
    gujarati: '👜 એક્સેસરીઝ',
  },
  {
    id: '6700f97c7c4f1bb93e48e300',
    apiName: 'Corporate Gift Articles',
    english: '🎁 Corporate Gifts',
    hindi: '🎁 कॉर्पोरेट गिफ्ट',
    gujarati: '🎁 કોર્પોરેટ ગિફ્ટ',
  },
  {
    id: '6700f8967c4f1bb93e48e2eb',
    apiName: 'Birthday Gifts',
    english: '🎂 Birthday Gifts',
    hindi: '🎂 बर्थडे गिफ्ट',
    gujarati: '🎂 બર્થડે ગિફ્ટ',
  },
  {
    id: '6700f8d87c4f1bb93e48e2f1',
    apiName: 'Electronic',
    english: '🔌 Electronics',
    hindi: '🔌 इलेक्ट्रॉनिक',
    gujarati: '🔌 ઇલેક્ટ્રોનિક',
  },
  {
    id: '6700f8787c4f1bb93e48e2e8',
    apiName: 'Monsoon Wear',
    english: '☔ Monsoon Wear',
    hindi: '☔ मॉनसून वियर',
    gujarati: '☔ મોન્સૂન વેર',
  },
  {
    id: '6700f85d7c4f1bb93e48e2e5',
    apiName: 'Winter Wear',
    english: '🧥 Winter Wear',
    hindi: '🧥 विंटर वियर',
    gujarati: '🧥 વિન્ટર વેર',
  },
  {
    id: '6700f93f7c4f1bb93e48e2fa',
    apiName: 'Home & Kitchenware',
    english: '🍳 Home & Kitchenware',
    hindi: '🍳 होम और किचनवेयर',
    gujarati: '🍳 હોમ અને કિચનવેર',
  },
  {
    id: '6700f91a7c4f1bb93e48e2f7',
    apiName: 'Thermoware',
    english: '🍵 Thermoware',
    hindi: '🍵 थर्मोवेयर',
    gujarati: '🍵 થર્મોવેર',
  },
  {
    id: '6700f9607c4f1bb93e48e2fd',
    apiName: 'Glassware',
    english: '🥂 Glassware',
    hindi: '🥂 ग्लासवेयर',
    gujarati: '🥂 ગ્લાસવેર',
  },
  {
    id: '68bd4f08881e164420ed0e8f',
    apiName: 'Copperware',
    english: '🟤 Copperware',
    hindi: '🟤 कॉपरवेयर',
    gujarati: '🟤 કોપરવેર',
  },
];

/** Build the website deep-link for a single category. */
function categoryUrl(cat) {
  const name = encodeURIComponent(cat.apiName);
  return `${CATALOG_SITE}/product-list?category=${cat.id}&categoryName=${name}`;
}

/** Browse-all URL — the website's full product list. */
function browseAllUrl() {
  return `${CATALOG_SITE}/product-list`;
}

module.exports = { CATEGORIES, categoryUrl, browseAllUrl, CATALOG_SITE };
