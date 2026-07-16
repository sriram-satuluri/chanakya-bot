// Detects language from customer's first message
// Returns 'english' | 'hindi' | 'gujarati'

function detectLanguage(text) {
  if (!text || text === '__IMAGE__') return 'english';

  // Check for Devanagari (Hindi) Unicode block U+0900–U+097F
  if (/[\u0900-\u097F]/.test(text)) return 'hindi';

  // Check for Gujarati Unicode block U+0A80–U+0AFF
  if (/[\u0A80-\u0AFF]/.test(text)) return 'gujarati';

  // Gujarati greeting/keyword patterns (romanized)
  const gujaratiKeywords = [
    'kem cho', 'kem chho', 'su che', 'su chhe', 'kevo', 'tamaro',
    'tamari', 'mari bag', 'maro', 'vadodara', 'baroda', 'shu', 'tamne'
  ];
  const lower = text.toLowerCase();
  if (gujaratiKeywords.some(k => lower.includes(k))) return 'gujarati';

  // Hindi keyword patterns (romanized)
  const hindiKeywords = [
    'namaste', 'namaskar', 'kya', 'meri bag', 'mera', 'aapka',
    'theek', 'karo', 'kaise', 'kitna', 'bhai', 'didi', 'haan', 'nahi',
    'kaisa', 'kahan', 'maine', 'tumhara', 'apna'
  ];
  if (hindiKeywords.some(k => lower.includes(k))) return 'hindi';

  return 'english';
}

module.exports = { detectLanguage };
