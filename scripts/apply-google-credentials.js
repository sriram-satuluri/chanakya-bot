const fs = require('fs');

const jsonPath = process.argv[2];
const envPath = process.argv[3] || require('path').join(__dirname, '..', '.env');
const sheetId = process.argv[4] || '';

if (!jsonPath) {
  console.error('Usage: node apply-google-credentials.js <path-to-service-account.json> [.env path] [sheet id]');
  process.exit(1);
}

const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const pk = j.private_key.replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
const email = j.client_email;

let e = fs.readFileSync(envPath, 'utf8');
if (sheetId) e = e.replace(/^GOOGLE_SHEETS_ID=.*$/m, `GOOGLE_SHEETS_ID=${sheetId}`);
e = e.replace(/^GOOGLE_SERVICE_ACCOUNT_EMAIL=.*$/m, `GOOGLE_SERVICE_ACCOUNT_EMAIL=${email}`);
e = e.replace(/^GOOGLE_PRIVATE_KEY=.*$/m, `GOOGLE_PRIVATE_KEY="${pk}"`);
fs.writeFileSync(envPath, e, 'utf8');
console.log('Patched', envPath, '- set Google Sheets credentials (private key not printed).');
