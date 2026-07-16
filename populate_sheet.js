require('dotenv').config();
const { google } = require('googleapis');

(async () => {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const id = process.env.GOOGLE_SHEETS_ID;

    const headerMap = {
      repair_tickets: ['ticket_id','customer_name','phone','bag_type','problem','store','status','before_photo_url','after_photo_url','created_at','updated_at','estimated_pickup','language','notes','last_reassurance_at'],
      product_catalog: ['product_id','category','brand','name','price_range','in_stock','description_en','description_hi','description_gu','image_url','store_availability'],
      leads_corporate: ['lead_id','company_name','contact_name','phone','product_type','quantity','budget','branding_needed','contact_time','created_at','status','owner_notes'],
      analytics_log: ['timestamp','phone','language','intent','customer_message','bot_response_summary','session_id','escalated_to_human'],
      broadcast_log: ['broadcast_id','template_name','sent_at','recipients','delivered','replies_received'],
      broadcast_queue: ['campaign_name','template_name','send_at','audience_filter','language','variables_json','status'],
      opt_in_contacts: ['phone','language','joined_at','opted_in'],
    };

    const data = [];
    for (const [tab, headers] of Object.entries(headerMap)) {
      data.push({ range: `${tab}!A1:${String.fromCharCode(64 + headers.length)}1`, values: [headers] });
    }
    // Ticket counter at P1
    data.push({ range: 'repair_tickets!P1', values: [[0]] });

    const res = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: id,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
    console.log('UPDATED_RANGES:', res.data.totalUpdatedRanges, 'CELLS:', res.data.totalUpdatedCells);

    const { applyRepairTicketStatusDropdown } = require('./src/services/sheets');
    await applyRepairTicketStatusDropdown();
    console.log('repair_tickets!G:G — status dropdown (data validation) applied.');

    console.log('OK');
  } catch (e) {
    console.error('ERROR:', e.message);
  }
})();
