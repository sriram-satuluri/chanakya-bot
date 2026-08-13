# Part 3 — WhatsApp Flow for repair intake (DEFERRED)

**Status: DEFERRED — pending input from the team. Do not build or submit.**

No code in this repo has been changed for this, and none should be until the
question below is answered. The existing `ask_name → ask_bag_type →
ask_problem → ask_photo → ask_store` flow is untouched and remains the only
intake path.

### Why it's deferred

The case for Flows rests on reducing mid-flow abandonment, but the
abandonment statistics that argument is usually built on come from **cold lead
capture** — someone with no prior commitment filling in a form. That is not
this situation. A customer booking a repair is already holding a damaged bag
and has decided to get it fixed; they are a far more committed moment than a
cold lead, so the drop-off pressure Flows are designed to relieve may simply
not exist here.

**Open action:** ask the store team whether they have actually observed
customers struggling with or abandoning the current 5-step booking. If they
have not, this proposal should stay shelved — it would spend Meta review
cycles (×3, see below) solving a problem we have no evidence of.

Everything below is preserved so it is ready to execute if that answer comes
back positive.

### Decisions already recorded

| Question | Decision |
|---|---|
| Photo inside the Flow? | **No** — collected as a normal message after the Flow completes (§2) |
| One Flow or three? | **Three**, one per language (§4) |
| Build now? | **No** — deferred pending the team's input |

---

## 1. Screen-by-screen mapping against the current 5 steps

The current flow is 5 round-trips (5 inbound + ~5 outbound messages). A Flow
collapses the four *data* steps into a single form the customer fills in one
sitting, then submits once.

| Current step | Flow equivalent | Component |
|---|---|---|
| `ask_name` | Screen 1, field 1 | `TextInput` (required, max 60) |
| `ask_bag_type` | Screen 1, field 2 | `Dropdown` — 7 static options |
| `ask_problem` | Screen 1, field 3 | `Dropdown` — 8 static options |
| `ask_store` | Screen 1, field 4 | `RadioButtonsGroup` — Alkapuri / Sursagar |
| `ask_photo` | **stays a normal message** — see §2 | (unchanged) |
| — | Screen 2 | `Footer` confirm + terms acknowledgement |

One screen is deliberate. Splitting name/bag/problem/store across four Flow
screens would recreate the round-trips the Flow is supposed to remove, while
adding a review cycle. A single scrollable form is the actual UX win.

**Completion handoff.** On submit, WhatsApp sends the webhook a message of
type `interactive` / `nfm_reply` carrying a `response_json` string with the
field values. `webhook/handler.js` already extracts `interactive` payloads, so
this needs one new branch that parses `response_json`, maps the four values
onto the same `collectedData` shape the current flow builds, and then hands
off to the **existing** ticket-creation code path — `generateTicketId()` →
`createRepairTicket()` → owner alerts → `askRepairUpdatesOptIn()`. None of
that logic changes.

---

## 2. Static Flow vs Data Exchange — and the photo

**Recommendation: Static Flow. Data Exchange is not needed and would be the
wrong call here.**

Data Exchange earns its complexity when screen content depends on live server
data, or when you must validate mid-flow. Neither applies:

- Bag types (7) and problems (8) are hardcoded constants in `flows/repair.js`.
- There are exactly 2 stores.
- Nothing needs validating server-side until submission.
- The ticket ID is generated *after* submit, not during.

A Data Exchange flow would add a public encrypted endpoint, key management, an
extra Meta review surface, and a new class of outage (endpoint down = intake
broken) for zero functional gain.

### The photo is the real design decision

`PhotoPicker` exists as a Flow component, but I am **not confident enough in
how it returns media** across Flow JSON versions to build against it blind —
whether the image arrives as a media handle to fetch, or inline, and whether
static flows can carry it at all given payload limits. Getting that wrong
means a rebuilt photo path and a second Meta review cycle.

**DECIDED: the photo stays out of the Flow**, collected as a normal WhatsApp
message after it completes. Sequence becomes:

1. Customer taps "Repair My Bag" → Flow opens → fills the four fields → submits.
2. Bot receives `nfm_reply`, stores the four values in the session, and asks
   for the photo using the **existing, unchanged** `ask_photo` step.
3. Customer sends the photo → **existing** `downloadMedia()` → `uploadBuffer()`
   Cloudinary path runs untouched → ticket created.

This reuses the entire Cloudinary chain with zero changes, sidesteps the
PhotoPicker uncertainty, and still removes 4 of the 5 round-trips. If
PhotoPicker later proves clean, moving it into the Flow is a contained
follow-up rather than a prerequisite.

---

## 2a. BINDING CONSTRAINT — ticket creation stays atomic

**Whenever this is built, the ticket row must NOT be written to the sheet
until the photo has also been received.** This is a hard requirement, not a
preference.

The tempting shortcut is to create the ticket the moment the Flow is
submitted — the four fields are right there — and then patch the photo URL
into the row when it arrives. **Do not do this.** It opens a window in which
a ticket exists with no photo at all, permanently, if the customer never
sends one. Someone submits the Flow, gets distracted, never follows up, and
the sheet now holds a ticket that looks real to staff but has no evidence of
the damage — the exact thing the photo is there to provide, and the thing the
before/after record depends on in a dispute.

**The current step-by-step flow structurally cannot produce that state**,
because `createRepairTicket()` is only reached after `ask_photo` has run. That
property is worth more than the convenience of an early write, and the Flow
version must preserve it exactly.

Required shape:

1. Flow submits → parse `nfm_reply`, hold the four values **in session only**
   (`collectedData`), exactly as the current flow accumulates them.
2. Set `flowStep = 'ask_photo'` and ask for the photo using the existing step.
3. Photo arrives → existing `downloadMedia()` → `uploadBuffer()` runs.
4. **Only now** call `generateTicketId()` → `createRepairTicket()` with all
   five values together, as a single write.

Note this also means the Flow version inherits the current flow's existing
behaviour for a *failed* photo upload — the ticket is still created, with an
empty photo URL and a warning to the customer, because at that point they did
send a photo and the failure is ours, not theirs. The constraint is about
never creating a ticket for a customer who never sent one at all.

Session expiry is the acceptable failure mode here, and matches today: if the
customer abandons after the Flow but before the photo, the session times out
and **no ticket is created** — which is correct. An abandoned booking should
leave no trace, not a half-formed record for staff to chase.

---

## 3. Shipping without risk to what already works

Gated additional entry point. The current flow stays the default and the
fallback:

```
REPAIR_FLOW_ENABLED=false     # master switch, default OFF
REPAIR_FLOW_ID=<id from Meta>
```

Routing, on `btn_repair`:

```
if (REPAIR_FLOW_ENABLED && REPAIR_FLOW_ID && flow-send succeeds)
      → Flow intake
else  → existing step-by-step (unchanged code path)
```

Properties that matter:

- **Default off.** Merging this changes nothing until you flip the flag.
- **Fail-open.** If the Flow send throws (unapproved, deprecated, wrong id,
  Meta outage), we log and fall through to the step-by-step flow in the same
  turn. The customer never sees a dead end.
- **Nothing existing is edited**, only added to. Every current test-checklist
  item passes unchanged with the flag off, so a Meta rejection or stalled
  review costs nothing.
- **Reversible instantly** — flip the flag back, no redeploy of logic.

Suggested rollout: flag on for your own number first → a week of real
customers with both paths live → only then consider retiring the old path
(and I would keep it as the fallback indefinitely, since it costs nothing).

---

## 4. Draft Flow JSON

Provided as a **starting point, not submission-ready**. Meta's Flow JSON
schema is versioned and its validator is strict about component names and
required properties per version; I would want to check the current version's
reference before you submit rather than have you burn a review cycle on a
schema mismatch. The *structure and field mapping* below is the reviewed part.

```json
{
  "version": "7.0",
  "screens": [
    {
      "id": "REPAIR_DETAILS",
      "title": "Book a Repair",
      "terminal": true,
      "data": {},
      "layout": {
        "type": "SingleColumnLayout",
        "children": [
          {
            "type": "TextBody",
            "text": "Tell us about your bag and we'll get a ticket started."
          },
          {
            "type": "Form",
            "name": "repair_form",
            "children": [
              {
                "type": "TextInput",
                "name": "customer_name",
                "label": "Your name",
                "input-type": "text",
                "required": true
              },
              {
                "type": "Dropdown",
                "name": "bag_type",
                "label": "Type of bag",
                "required": true,
                "data-source": [
                  { "id": "0", "title": "Trolley / Luggage Bag" },
                  { "id": "1", "title": "Backpack" },
                  { "id": "2", "title": "School Bag" },
                  { "id": "3", "title": "Laptop Bag" },
                  { "id": "4", "title": "Handbag / Purse" },
                  { "id": "5", "title": "Duffel Bag" },
                  { "id": "6", "title": "Other" }
                ]
              },
              {
                "type": "Dropdown",
                "name": "problem",
                "label": "What's wrong?",
                "required": true,
                "data-source": [
                  { "id": "0", "title": "Zip / Chain Issue" },
                  { "id": "1", "title": "Wheel Issue" },
                  { "id": "2", "title": "Handle Issue" },
                  { "id": "3", "title": "Lock Issue" },
                  { "id": "4", "title": "Stitching / Tear" },
                  { "id": "5", "title": "Cleaning / Polishing" },
                  { "id": "6", "title": "Lining Issue" },
                  { "id": "7", "title": "Other" }
                ]
              },
              {
                "type": "RadioButtonsGroup",
                "name": "store",
                "label": "Which store will you bring it to?",
                "required": true,
                "data-source": [
                  { "id": "store_alkapuri", "title": "Alkapuri - Race Course Road" },
                  { "id": "store_sursagar", "title": "Sursagar - Opp. Pratap Talkies" }
                ]
              },
              {
                "type": "TextCaption",
                "text": "By submitting you accept our Terms. Repair begins only after you approve the quotation."
              },
              {
                "type": "Footer",
                "label": "Submit",
                "on-click-action": {
                  "name": "complete",
                  "payload": {
                    "customer_name": "${form.customer_name}",
                    "bag_type": "${form.bag_type}",
                    "problem": "${form.problem}",
                    "store": "${form.store}"
                  }
                }
              }
            ]
          }
        ]
      }
    }
  ]
}
```

**Note on the ids.** `bag_type` / `problem` ids are the numeric indices the
existing `resolveBagType()` / `resolveProblem()` resolvers already accept
(`bag_3`, `prob_1`), and `store` uses the existing `store_alkapuri` /
`store_sursagar` ids that `resolveStore()` already understands. That is
deliberate — the completion handler can feed these straight into the current
resolvers with no new mapping table to keep in sync.

**Localisation — DECIDED: three separate Flows**, one per language, selected
by the customer's stored language preference. This matches the pattern already
used for the status/feedback templates (`_en` / `_hi` / `_gu`) and for the
trilingual keyword sets, rather than introducing a second, different approach
using conditional logic inside a single Flow.

Consequences to plan for:

- The JSON above is the **English** Flow. Two more are needed with the
  `title`, `label`, `text` and `data-source` titles translated. The `id`
  values must stay identical across all three so one completion handler
  works for all of them.
- Three Flow ids to store, e.g. `REPAIR_FLOW_ID_EN` / `_HI` / `_GU`,
  selected the same way `TEMPLATE_BY_LANG` already selects templates.
- **Three Meta review cycles**, and three again for any future wording
  change. This is the main ongoing cost of the decision and a large part of
  why the deferral question above matters.

---

## Decisions recorded

1. **Photo in-Flow or after?** → **After.** Photo stays a normal message; the
   existing Cloudinary path is reused unchanged (§2), subject to the atomicity
   constraint in §2a.
2. **One Flow or three?** → **Three**, one per language (§4).
3. **Build now?** → **No.** Deferred pending the team's answer on whether
   customers actually struggle with the current booking flow (see top).

Nothing further should be built or submitted against this document until that
third point is resolved.
