const { getLastTicketNumber, setLastTicketNumber } = require('../services/sheets');

/**
 * Single-node mutex around counter increment. Prevents two simultaneous
 * repair-ticket submissions from generating the same ID.
 * NOTE: Only correct while the bot runs as a single process. If we horizontally
 * scale to multiple nodes, move the increment into a Sheets batchUpdate with
 * value_input_option: USER_ENTERED and a formula-side +1, or use Redis INCR.
 */
let _generationChain = Promise.resolve();

async function generateTicketId() {
  const run = _generationChain.then(async () => {
    const year = new Date().getFullYear();
    const lastNum = await getLastTicketNumber();
    const nextNum = (lastNum || 0) + 1;
    await setLastTicketNumber(nextNum);
    const padded = String(nextNum).padStart(4, '0');
    return `CHA-${year}-${padded}`;
  });
  // Keep chain rolling but don't propagate rejection so future calls aren't stuck
  _generationChain = run.catch(() => {});
  return run;
}

module.exports = { generateTicketId };
