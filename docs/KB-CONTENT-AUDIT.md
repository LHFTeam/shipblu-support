# Knowledge base content audit

Audited 2026-08-31 against the production project `nqbcfnvqqyqawmffgiql`. Every
figure below came from a `SELECT`; nothing was written.

This file is about the **content**, not the platform. The help centre itself is
in good shape — breadcrumbs with `BreadcrumbList`, canonical plus `hreflang`
across the translation group, related articles, a feedback control, a view
beacon, viewer-gated visibility, RTL that works. What is published inside it is
a Freshdesk export that was **moved rather than rewritten**, and it shows in
every measurement that exists.

## 1. What is actually in there

|                                |                                                            |
| ------------------------------ | ---------------------------------------------------------- |
| Articles                       | 112 (58 `ar`, 54 `en`), all `published`                    |
| Structure                      | 5 categories, 20 folders (16 public, 4 `agents_only`)      |
| Body text                      | 995 characters mean, 3,904 longest, 2 articles at **zero** |
| Imported counters              | 63,799 views, 548 helpful, 2,313 unhelpful                 |
| Native feedback                | **0 rows** in `kb_article_feedback`                        |
| Versions / authors / approvals | **0 / 0 / 0**                                              |

The view and helpfulness counters are Freshdesk's, carried over by the import
and now frozen into the same columns the live site increments. There is no way
to separate the imported baseline from anything earned since — worth fixing
before anyone reports on them.

## 2. The audience is inverted

The bot channel has 13,693 conversations and 44,376 inbound messages from
2026-08-19 to 2026-08-30. Classified by keyword, what people actually ask:

| Topic                                | Messages | Share |
| ------------------------------------ | -------: | ----: |
| Address confirmation / correction    |   20,743 | 46.7% |
| Delivery date and timing             |    7,669 | 17.3% |
| Shipment cost and payment method     |    3,935 |  8.9% |
| Nobody contacted me / failed attempt |    3,891 |  8.8% |
| Add a note to the order              |      773 |  1.7% |
| Cancel                               |      272 |  0.6% |

Every one of those is a **recipient**, in Arabic, about a parcel already moving.
The knowledge base is 94 merchant articles to 14 recipient ones:

| Audience             | Articles |  Views |   Helpful |
| -------------------- | -------: | -----: | --------: |
| Merchant (partner)   |       94 | 51,037 |     24.6% |
| Recipient (consumer) |       14 | 12,762 | **14.9%** |
| Internal (agents)    |        4 |      0 |         — |

12.5% of the content serves ~100% of the live inbound volume, and it is the half
that rates worst.

### The gap is provable, not inferred

Search is `websearch_to_tsquery('simple', …)` with trigram similarity on the
title as backstop (`lib/kb/rank.ts`) — no stemming and no synonyms in either
language, so the words a customer types have to be literally present. Running
real phrasings lifted from the message table against the live predicate:

| Phrase                   | FTS hits | Top result                                  |
| ------------------------ | -------: | ------------------------------------------- |
| `عايز اغير العنوان`      |        0 | —                                           |
| `عايز اغير معاد التوصيل` |        0 | —                                           |
| `محدش كلمني`             |        0 | —                                           |
| `ازاي ادفع بالفيزا`      |        0 | —                                           |
| `عايز ارجع المنتج`       |        0 | —                                           |
| `تكلفة الشحن`            |        0 | الشحنات التالفة (damaged shipments)         |
| `pay by card`            |        2 | How to Request Supplies/Packaging Materials |
| `courier phone number`   |        3 | How to Create a Single Return Order         |

Ten of sixteen tested phrasings return nothing; several of the rest return
something actively wrong. There is no article at all on changing a delivery
address, rescheduling a delivery, paying at the door, reaching the courier, or
refusing a parcel — the top four topics by volume.

## 3. The top articles do not answer their own question

| Article                                                      | Views | Helpful |
| ------------------------------------------------------------ | ----: | ------: |
| Detailed Timeline (ShipBlu Tracking Tool)                    | 4,723 |   11.5% |
| شحنتي فين؟                                                   | 3,613 |   11.5% |
| Where's my package?                                          | 2,804 |   10.0% |
| مكتوب إن الاوردر خرج للتوصيل، هيوصل امتي؟                    | 1,828 |   23.1% |
| My order says "Out for Delivery", when will it be delivered? | 1,439 |   19.9% |
| إرشادات التعبئة والتغليف                                     | 1,805 |   50.0% |

The cause is visible in the body. `Where's my package?` is 63 words that say:
track it yourself, or email support, and here are the support hours. It routes,
it does not answer. Nothing in it tells the reader what a status means, when to
worry, or what happens next — the three things somebody asking that question
wants. The imported ratio (a 10% helpfulness across 429 votes) is the readers
saying so.

Answer-first is the settled convention here: lead with the answer to the title,
then the qualifier, then the escalation path last. Every one of these leads with
the escalation path.

The packaging pair inverts the pattern and is worth reading carefully. Those two
articles are **the best-rated content in the knowledge base** — 85.7% and 83.3%
— and they contain no prose whatsoever, only screenshots. Readers are not asking
for more words; they are asking for the answer, and a labelled picture of a
correctly packed parcel is one. The lesson is not "add text to the pictures", it
is that the text everywhere else is not carrying its weight.

## 4. Defects worth fixing regardless of strategy

Each was found by query and can be re-found the same way.

1. **An LLM transcript artifact is published.** `ما هو تطبيق ماي بلو` contains
   the literal string `You said:` mid-body, where a drafting session was pasted
   in without being read.
2. **Two articles have no text at all.** `Packaging Guidelines` (813 views) and
   `إرشادات التعبئة والتغليف` (1,805) are images only. They are also the two
   best-rated articles in the KB, which is the awkward part: 2,618 views of
   content people clearly like, that is nonetheless invisible to
   `search_vector`, to screen readers, to translation, and to anything that
   would retrieve an answer for the bot. They need a text layer beside the
   pictures, not instead of them.
3. **214 images across 61 articles are hot-linked from
   `s3.amazonaws.com/cdn.freshdesk.com`.** They still resolve today (checked, 200) — they resolve for exactly as long as the Freshdesk account is open.
   Closing it silently empties 61 articles, two of which are nothing else.
4. **61 articles carry images with no `alt`.**
5. **The four internal handbook articles are empty stubs** titled
   `مقالة جديدة`, one per team folder.
6. **No article links to another article.** Zero `href`s to `/a/`. The
   cross-references exist as prose — "as explained in the _Where's my package?_
   article", "كما موضح في مقال تتبع الاوردر" — and the Arabic one names a title
   that does not exist.
7. **Duplicates with divergent content.** Six slugs carry a `-2` suffix, and
   both copies sit in the same folder. `Order Delivery Dates and Days` exists
   twice — one written about the customer in the third person, one addressing
   the reader directly, and only one of them carries the visiting-days link.
   `Reaching Client Support Team` is the same story. A searcher gets both and
   has no way to tell which is current.
8. **95 of 112 excerpts are truncated body text** ending in `…`, and 31 begin
   with the raw `*` of a bullet. Excerpts are what a searcher reads in results
   and what goes out as the OG description.
9. **87 articles carry inline `style=`; 78 hardcode a font or colour** — fighting
   the `.kb-shell` tokens the design system swap just landed.
10. **12 slugs contain punctuation**, e.g. `شحنتي-فين؟`.
11. **Title hygiene.** `I did not Recieve my Order yet` (309 views),
    `Billing Days || Transfer Cycle and Fees`, three titles with a double space.
12. **Contact details and working hours are duplicated verbatim in 15
    articles.** There is no single source, and `business_hours` plus the
    `KB_NOTICE_*` mechanism already exist.

## 5. Arabic is the front door and the thinner half

Arabic is the default locale, is 58 of the 112 articles, and takes essentially
all live traffic — and it is systematically shorter than its English pair:
888 characters mean against 1,110.

| Pair                            |  `en` |  `ar` | Loss |
| ------------------------------- | ----: | ----: | ---: |
| Analytics / التحليلات           | 2,723 | 1,447 | −47% |
| myBlu / ماي بلو                 | 1,314 |   738 | −44% |
| Payout method / تسجيل حساب بنكي | 1,437 |   842 | −41% |
| Action Center / مراجعه الطلبات  | 1,763 | 1,239 | −30% |

What the Arabic gets right is worth protecting: the consumer titles are in
Egyptian colloquial — `شحنتي فين؟`, `هيوصل امتي؟` — which is what people type,
and with `simple` FTS that literal match _is_ the retrieval mechanism. The
merchant Arabic is formal MSA and does not match how merchants write.

## 6. Governance does not exist yet

`kb_article_versions`, `author_agent_id` and `approved_by_agent_id` are all
empty, and every article's `updated_at` is the import timestamp — so all 112
pages tell the reader "Updated 19 August 2026", which is a freshness signal that
carries no information. There is no owner, no review date and no retirement rule
on any article.

## 7. Recommendations, in the order they pay

**Now — cheap, and each removes a visible defect**

- Strip the `You said:` artifact.
- Re-host the 214 Freshdesk images into the attachments bucket and rewrite the
  `src`s, before the vendor account closes rather than after. This one has a
  clock on it that nobody here controls.
- Add `alt` text on the way through, and give the two image-only articles a
  text layer beside the screenshots so they are searchable and translatable.
- Merge the six duplicate pairs, keep one slug, add a `kb_redirects` row for the
  other.
- Fix the typo and the `||` titles, drop punctuation from the 12 slugs (with
  redirects).
- Hand-write the excerpts, or at least the top twenty by views.

**Next — the content that is missing**

Ten articles, drawn from the demand table, Arabic first and colloquial:
changing the delivery address; rescheduling a delivery; what each tracking
status means for a recipient (recipient-facing, not the merchant timeline);
what to do when nobody called; paying by card or wallet at the door; reaching
the courier; refusing or returning at the door; what happens after a failed
attempt; the delivery window and why it moves; adding a note to an order.

Then rewrite the six highest-traffic articles answer-first, and cross-link them
properly — the prose references become real links.

**Then — stop it decaying again**

- Capture the `comment` on a "No". The column exists and nothing writes it;
  "what were you looking for?" on a negative vote is the highest-yield input
  there is for knowing what to write next.
- Separate imported counters from earned ones before anyone reports on them.
- Give articles an owner and a review date, and put the stale ones on a report.
- Rank related articles by something other than `helpfulCount` — it is currently
  ranking by an imported, mostly negative counter.
- Emit `FAQPage`/`Article` JSON-LD alongside the existing `BreadcrumbList`.
- Feed the bot from the KB rather than from a parallel script, so a rewritten
  article improves both surfaces at once.
