# Repair sheet — staff card

The WhatsApp bot reads and writes the Google Sheet. Wrong cells look like a broken bot to the customer.

## You may edit

| Column | What | Rules |
|---|---|---|
| **G status** | Where the bag is | Use the **dropdown only**. Do not type a variant. Each change can WhatsApp the customer. |
| **L estimated pickup** | Date you told them | Optional. Shown on Track. |
| **N notes** | Internal | Customers never see this. |
| **H / I photos** | Before / after | Bot fills these. Do not paste random text here. |

Leave **A ticket id**, **C phone**, **P1 counter** alone.

Ticket IDs are `CHA-R-…` (Alkapuri) or `CHA-S-…` (Sursagar). Older rows may still be `CHA-2026-…` without a letter.

## Status meanings (column G)

1. **Bag Yet To Be Received…** — ticket booked, bag not at the store yet.
2. **Bag Received** — they dropped it off.
3. **Inspection Done** — you have looked at it (quote is in person, not on WhatsApp).
4. **Repair In Progress**
5. **Repair Complete**
6. **Ready for Pickup** — customer is notified once, then we stop chasing.
7. **Cannot Repair**
8. **Picked Up** — stop all further pings.

If a row sits on (1) for a week, they probably never came. Run `npm run sheet:orphans` or call them.

## Do not

- Type a new status wording. The dropdown is the contract with WhatsApp.
- Clear **P1**. That is the ticket counter. Resetting it reissues old IDs.
- Delete header row 1.
- Put a formula in a customer-name or notes cell that starts with `=`.

## First-time setup

```bash
npm run sheet:status-dropdown
```

That puts the dropdown on column G. Re-run if the dropdown vanishes.

## Weekly

```bash
npm run funnel              # where people drop off while booking
npm run sheet:orphans       # booked, never arrived
```
