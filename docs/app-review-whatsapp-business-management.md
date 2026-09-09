# The `whatsapp_business_management` App Review submission

Fourth of the set, and the one the other three kept pointing at. Written
2026-09-09 against production.

**It corrects yesterday's file.** `docs/app-review-whatsapp-business-messaging.md`
said the hourly template sync "is succeeding today", on the evidence of 36
templates sitting in the table. The table was right and the inference was
wrong: the sync has succeeded **once**, and every run before and since has been
refused. That correction is the strongest thing this submission has going for
it, so it leads.

## What the app uses it for, and what Meta is doing about it

`syncWhatsAppTemplates` runs hourly from the `shipblu-whatsapp-template-sync`
cron and calls `listTemplates` → `GET /{waba-id}/message_templates` for every
connected WhatsApp Business Account. Templates are written and approved in
Meta's Business Manager rather than here, so without that read the console's
template list drifts — and an agent picking a template Meta has since rejected
gets an opaque send failure at the worst possible moment, which is the one time
they are allowed to message a customer at all.

**That call is being refused, hourly, on both accounts:**

```
[sync_whatsapp_templates] Merchant Care WABA: (#200) You do not have permission to access this field.
[sync_whatsapp_templates] WhatsApp: (#200) You do not have permission to access this field.
[job] failed Error: 2 of 2 WhatsApp business account(s) failed to sync
```

Code 200 is Graph refusing the app rather than the request. The cron has been
red every hour since, which is its own small problem — `docs/PROJECT-STATE.md`
§5.1 already says a cron that is always red is a cron nobody reads, and then
the first real failure goes unnoticed.

**There is exactly one successful call in the record, and it is datable to the
minute.** At **2026-09-02 11:01:12 UTC** the sync ran clean — `WhatsApp: synced
36` — and all 36 template rows in the database carry that instant as their
`synced_at`, to the millisecond. The runs at 00:00 and 01:00 that morning were
already refused, and every run since has been. So the console's template list
is a photograph of one minute on 2 September.

**That minute is not a coincidence, and it is worth knowing before anybody
"fixes" the token.** The `permissions` webhook records a re-authorisation at
10:43:06 that morning — `instagram_manage_comments`, `pages_manage_engagement`,
`pages_manage_posts` and `pages_read_engagement` all granted in one batch — and
`pages_messaging` **revoked** at 11:17:07, then granted again on 2026-09-08.
The one successful template sync falls between those two events. Whatever was
done to the authorisation that morning briefly carried WhatsApp management
access and then did not. This is a grant that has been held and lost rather
than one never requested, which is a different conversation to have with Meta.

## Before you paste any of this

**The dependency runs the other way here, and this permission is the root.**
Meta lists no dependencies for `whatsapp_business_management`, and
`whatsapp_business_messaging` **requires** it. So this is the one to get right:
approving the messaging permission without this one leaves the template list
frozen exactly as it is now, and the messaging submission cannot be granted
without it at all.

**The screencast is satisfiable today, and by Meta's own tool.** The
requirement is:

> "Show creation of a message template via your app or WhatsApp Manager"

The "or WhatsApp Manager" is the part that matters. This app **reads**
templates and does not create them — there is no template composer in the
console, deliberately, because approval happens in Business Manager — so the
first half is not filmable and does not need to be. Record the creation in
WhatsApp Manager, which is Meta's own surface and explicitly accepted.

The stronger recording adds the second half: create the template in WhatsApp
Manager, then show it appearing in the console's template picker after the
hourly sync. **That half requires the permission to be working**, so it is a
recording to make after the grant, not before. Do not attempt it now — the sync
is refused and the template would never appear.

**The "successful call" gate is satisfied, but only just.** Meta wants a
successful call inside the 30 days before submission, and there is one:
2026-09-02 11:01:12. That expires on 2 October. If the submission slips past
that, the counter has nothing to point at and there is no way to make a new
call while the permission is refused — so submit before then, or expect to
have to restore the grant first.

## A. Use case description

Meta's prompt is _"Provide specific examples of why your app requires access to
the business assets of a business that has onboarded onto your platform."_ As
with the messaging permission, that assumes a platform serving other
businesses. Answer it as it stands rather than inventing one.

```text
ShipBlu Support is the in-house helpdesk that ShipBlu, a last-mile delivery
company operating in Egypt, uses to answer its own customers. It is a
single-tenant application. No business has been onboarded onto it and it has no
facility to onboard one: the only WhatsApp Business Accounts it reads are
ShipBlu's own, and the only people who use the application are ShipBlu's own
support agents. The business asset it needs access to is our own.

We use whatsapp_business_management for one thing: reading the message
templates that belong to our WhatsApp Business Accounts.

Our support agents answer customers on WhatsApp from this application. When a
customer wrote to us more than 24 hours ago, Meta's rules do not allow a
free-form reply, and the only thing that will send is a template approved for
our business account. The application therefore refuses to let an agent write a
free-form message once that window has closed, and offers them the approved
templates instead.

To do that it has to know which templates exist and which are currently
approved. Templates are created and submitted for approval in Meta's Business
Manager, not in this application — we do not build a template composer, because
Business Manager already is one. So an hourly job reads
GET /{waba-id}/message_templates for each of our business accounts and updates
our local copy: new templates become available to agents, and a template Meta
has rejected or paused stops being offered. Without that read our agents are
choosing from a stale list, and the failure lands on the customer — an opaque
send error at the one moment we are permitted to message them.

We do not create, edit or delete templates through the API. We do not read
phone numbers, QR codes, or analytics. We do not access any WhatsApp Business
Account other than the two that belong to ShipBlu.
```

## B. Step-by-step instructions for the reviewer

```text
Test account
  URL:      https://<console-host>/login
  Email:    <reviewer agent email>
  Password: <supplied in this form>

1. In WhatsApp Manager, create a message template on our WhatsApp Business
   Account and submit it for approval.

2. Open the URL above and sign in as a ShipBlu support agent.

3. Open a WhatsApp ticket whose customer last wrote more than 24 hours ago. The
   composer does not offer a free-form reply on this ticket — the 24-hour
   customer service window has closed — and shows the approved templates for
   our business account instead.

4. The template created in step 1 appears in that list once it is approved and
   our hourly sync has run. That sync is the only call this permission is
   requested for: it reads GET /{waba-id}/message_templates and updates the
   list the agent is choosing from.

5. Selecting a template shows the agent a preview of exactly what the customer
   will receive before they send it.
```

## C. What the claims above rest on

| Claim                                       | Checked how                                                      | Answer on 2026-09-09                                                      |
| ------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The app calls this hourly                   | `render.yaml` cron `shipblu-whatsapp-template-sync`, `0 * * * *` | runs `sync_whatsapp_templates`, then `snapshot_backlog`                   |
| The call is refused                         | Render logs on `crn-da1jgtg1ne8s73ciquk0`                        | `(#200) You do not have permission to access this field.`, both WABAs     |
| It has been refused all day                 | the same logs, 2026-09-09                                        | 15:00, 16:00, 17:00, 18:01 — every run, job marked failed                 |
| Exactly one successful call exists          | the same logs, text `synced`                                     | `WhatsApp: synced 36` at **2026-09-02 11:01:12**; refused at 00:00, 01:00 |
| The template list is frozen at that instant | `whatsapp_templates.synced_at`                                   | all 36 rows carry `2026-09-02 11:01:12.371`, 35 APPROVED and 1 REJECTED   |
| Something changed the grant that morning    | `permissions` webhooks in `webhook_events`                       | batch granted 10:43:06; `pages_messaging` revoked 11:17:07                |
| `whatsapp_business_messaging` depends on it | Meta's permission reference                                      | dependency: `whatsapp_business_management`; this one has none of its own  |
| The app never writes a template             | `lib/whatsapp/client.ts` — every exported function               | `listTemplates` is the only management call; the rest are messaging       |

## D. Before pressing submit

- [ ] **Submit this with `whatsapp_business_messaging`, and treat this one as
      the blocker.** Messaging depends on it; approving messaging alone leaves
      the template list frozen where it is.
- [ ] **Watch the 30-day window on the successful call.** The only one is
      2026-09-02 11:01:12 and it ages out on 2 October. While the permission is
      refused there is no way to make another, so a slip past that date means
      restoring the grant first.
- [ ] **Work out what happened on 2026-09-02 between 11:01 and the next run.**
      One sync succeeded and nothing has since. Whoever re-authorised that
      morning may be able to say what changed, and this is a grant that was held
      and lost rather than never requested — which is worth stating to Meta if
      the submission is queried.
- [ ] **Record the creation in WhatsApp Manager**, which the requirement
      explicitly accepts. Only add the console half after the grant lands, when
      the sync can actually deliver the template into the picker.
- [ ] **The cron is red every hour meanwhile.** Not a submission item, but it
      is the alarm that will be ignored when something else breaks — worth a
      decision either way before it becomes background noise.
