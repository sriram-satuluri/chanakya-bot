require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { google } = require('googleapis');

(async () => {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEETS_ID });
    const tabs = meta.data.sheets.map(s => s.properties.title);
    console.log('TITLE:', meta.data.properties.title);
    console.log('TABS:', JSON.stringify(tabs));
    const required = ['repair_tickets','product_catalog','leads_corporate','analytics_log','broadcast_log','broadcast_queue','opt_in_contacts'];
    const missing = required.filter(t => !tabs.includes(t));
    console.log('MISSING_TABS:', JSON.stringify(missing));
    for (const tab of required.filter(t => tabs.includes(t))) {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: `${tab}!1:1` });
      console.log(`HEADERS_${tab}:`, JSON.stringify(r.data.values ? r.data.values[0] : []));
    }
    // Check P1 ticket counter
    if (tabs.includes('repair_tickets')) {
      const p1 = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: 'repair_tickets!P1' });
      console.log('TICKET_COUNTER_P1:', JSON.stringify(p1.data.values));
    }
  } catch (e) {
    console.error('ERROR:', e.message);
  }
})();
