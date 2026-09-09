# The `whatsapp_business_messaging` App Review submission

Third of the set, after `docs/app-review-instagram-manage-comments.md` and
`docs/app-review-pages-read-engagement.md`. Written 2026-09-09 against
production.

**This is the one that can actually be filmed.** Both Meta permissions above
open their screencast requirement with "demonstrate the complete Facebook login
process", which this app has no flow for. This one does not. Meta asks to see:

> "Show your app sending a WhatsApp message to a number with the recipient's
> client receiving it (may use Meta App Dashboard's cURL generator)"

That is a thing the app has done — three delivered sends from the support
number — and it needs no login beat, no post content, and no permission that is
still being applied for. Four caveats stand between here and pressing record,
and they are the rest of this section.

## Before you paste any of this

**1. It has a dependency nobody has requested, and that dependency is
refused.** Meta's reference states that `whatsapp_business_messaging`
**requires `whatsapp_business_management`**. That permission is on no line of
`plans/meta-app-review-submission.md`'s eleven requests, and the app depends on
it hourly: the template sync calls `listTemplates` →
`GET /{waba-id}/message_templates`, which is a management call rather than a
messaging one.

The first version of this file read the 36 templates in the table as proof that
call was working. It is not: the sync has succeeded **once**, at 2026-09-02
11:01:12, which is the `synced_at` on all 36 rows, and every run before and
since is refused with `(#200) You do not have permission to access this field.`
The cron has been red every hour for a week.
`docs/app-review-whatsapp-business-management.md` is that submission, and it is
the blocker for this one — messaging cannot be granted without it.

**2. Inbound is switched off on purpose, and it does not block the recording.**
WhatsApp deliveries have failed signature verification since **2026-08-30
15:01:41 UTC** — 740 of them, still arriving, the most recent 2026-09-09
10:19. That is deliberate: the secret is mismatched so the Facebook and
Instagram work can have the attention (see the commit "Reframe the plan: the
muted WhatsApp secret is a test condition"). Meta's requirement above is
satisfied by the **send** alone, so this does not stop the footage. It does
stop a realistic support round-trip — customer writes in, ticket opens, agent
answers — so if you want that on film, restore verification first.

**3. Nothing has been sent since 2026-08-27, and no template has ever been
sent.** Four outbound messages exist in the whole archive: one failed on
2026-08-18 before the number was configured, and three delivered — 10:13 and
10:15 on 2026-08-18, and 14:06 on 2026-08-27. **Every one is `sendKind: text`.**
`sendTemplate` is shipped, is what the console offers when the 24-hour window
has closed, and has never run in production. So: **send one test message before
filming**, and do not build the screencast around the template path.

**4. There are two numbers and only one of them is ours to answer.** The WABA
carries `838961722630554` ("WhatsApp Support", the line agents work) and
`128318316834446` ("WhatsApp Customer Bot"). The bot number is where all the
volume is — **44,149 inbound messages and zero outbound** — and this app never
sends on it: `lib/tickets/channel-policy.ts` makes `whatsapp_bot` a read-only
channel, in its own words because "sending from this number would interrupt the
bot mid-flow". The submission describes the support line. Presenting the bot
archive as this app's support traffic would be a false statement about
conversations the app is not a party to, and the volume figure is the one thing
in this file most likely to be quoted carelessly.

## A. Use case description

Meta's prompt for this permission is _"Explain the messaging functionality your
app offers to business customers who you have onboarded onto the platform, and
how they perform those functions."_ That prompt assumes a platform serving
other businesses, and this app serves exactly one — its owner's. Answer it
directly rather than pretending otherwise.

```text
ShipBlu Support is the in-house helpdesk that ShipBlu, a last-mile delivery
company operating in Egypt, uses to answer its own customers. It is a
single-tenant application. We have not onboarded any other business onto it and
it has no facility to do so: the only WhatsApp Business Account it is connected
to is ShipBlu's own, and the only people who use the application are ShipBlu's
own support agents.

WhatsApp is how most of our customers reach us. A customer messages our support
number to ask where a parcel is, to change a delivery address, or to report a
problem with a driver. This application is what our agents answer them in, and
it uses whatsapp_business_messaging for four things:

1. Replying to a customer. An agent types an answer on the ticket and we send
   it to the customer's number as a text message, in the conversation they
   started. This is the core of the product: every WhatsApp support reply
   ShipBlu sends goes through this call.

2. Sending an approved template when the 24-hour customer service window has
   closed. If a customer wrote to us yesterday and the answer only arrives
   today, a free-form message is not permitted, so the agent picks from the
   templates approved for our business account and we send that instead. The
   application enforces this rule itself: it refuses to write a free-form reply
   to the ticket at all once the window has closed, rather than letting an
   agent believe a message was sent that Meta would reject.

3. Retrieving media the customer sent us. Customers send photographs of a
   damaged parcel, a screenshot of an order, or a voice note describing an
   address. We resolve the media ID from the webhook and download the file so
   the agent can see it on the ticket beside the message.

4. Marking a customer's message as read, so the read receipt the customer sees
   in WhatsApp matches whether an agent has actually opened their conversation.

Our WhatsApp Business Account also has a second number that runs an automated
customer flow operated outside this application. This application archives
those conversations read-only so the team can search them, and it never sends a
message on that number — sending there would interrupt the automated flow
mid-conversation. All outbound messaging described above is on our support
number only.

We do not send marketing or promotional messages, we do not send to numbers
that have not written to us first except by approved template in reply to an
existing conversation, and we do not message on behalf of any business other
than our own.
```

## B. Step-by-step instructions for the reviewer

```text
Test account
  URL:      https://<console-host>/login
  Email:    <reviewer agent email>
  Password: <supplied in this form>

1. Open the URL above and sign in. You are signed in as a ShipBlu support
   agent.

2. From a WhatsApp account of your own, send a message to our support number
   <support number in international format>.

3. In the console, open Inbox. A ticket appears on the WhatsApp channel
   carrying your message and your number. Open it.

4. Type a reply in the composer and send it. Your WhatsApp client receives it
   in the same conversation, from our business number, within a few seconds.
   The ticket records it as sent and then as delivered, from Meta's own
   delivery status.

5. Send us a photograph from WhatsApp. It appears on the ticket as an
   attachment the agent can open — this is the media retrieval described in the
   use case.

6. To see the 24-hour window rule, open a ticket whose customer last wrote more
   than 24 hours ago. The composer refuses a free-form reply and offers the
   approved templates for our business account instead.
```

## C. The screencast

Meta accepts a recording of the app sending a WhatsApp message with the
recipient's client receiving it. Film steps 2–4 above with the phone on screen
beside the console, so the message arriving in WhatsApp is visible in the same
frame as the console that sent it.

Two things to decide before recording:

- **Whether inbound is restored.** With verification still muted, step 2 does
  not produce a ticket and the recording has to start from an existing
  conversation instead — which still satisfies Meta's requirement, since it
  asks only for the send. Restoring it makes the whole flow filmable and is the
  better recording.
- **Do not film step 6.** The template path has never run in production. Meta's
  requirement does not ask for it, and a refusal on camera is worse than an
  omission.

## D. What the claims above rest on

| Claim                                         | Checked how                                                       | Answer on 2026-09-09                                                               |
| --------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The app can send, and has                     | `messages` joined to `conversations` where channel is `whatsapp`  | 4 outbound: 3 delivered (2026-08-18 ×2, 2026-08-27), 1 failed before setup         |
| Every send was free-form text                 | `meta->>'sendKind'` on those rows                                 | `text` on all four; no template send exists                                        |
| Nothing sent since 2026-08-27                 | the same query, ordered by date                                   | last outbound 2026-08-27 14:06:24                                                  |
| Inbound is failing verification, deliberately | `webhook_events` where object is `whatsapp_business_account`      | 199,372 verified up to 2026-08-30 15:01:41; 740 unverified since, last today       |
| The bot number is archive-only                | `messages` by channel; `lib/tickets/channel-policy.ts`            | 44,149 inbound on `whatsapp_bot`, **0 outbound**; the channel is read-only in code |
| Which number is which                         | `channels` rows                                                   | Support `838961722630554`, Customer Bot `128318316834446`                          |
| The management dependency is already in use   | `whatsapp_templates`; `listTemplates` in `lib/whatsapp/client.ts` | 36 templates synced, `APPROVED` and `REJECTED`, by an hourly cron                  |
| `whatsapp_business_messaging` requires it     | Meta's permission reference                                       | dependency: `whatsapp_business_management`                                         |

## E. Before pressing submit

- [ ] **Add `whatsapp_business_management` to the submission.** It is this
      permission's documented dependency and the app already calls it hourly.
- [ ] **Send one message from the console and watch it arrive**, before
      filming. The last successful send was thirteen days ago and the token has
      not been exercised since; a recording of a refusal is a rejected
      submission.
- [ ] **Decide whether to restore inbound verification** for the recording, and
      put it back the way you want it afterwards either way.
- [ ] **Check the support channel's account link.** The `WhatsApp Support` row
      has no `whatsapp_account_id`, so it falls back to the environment
      credentials rather than a configured connection — `docs/PROJECT-STATE.md`
      §5.1 explains why that matters for which token a reply sends with.
- [ ] **Do not quote the 44,149 figure as support volume.** It is the bot
      number's archive, and this app has never sent a message on it.
