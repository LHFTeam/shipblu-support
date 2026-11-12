# Disconnecting Freshdesk: what still depends on it, and the order to undo it

The question was whether anything in the knowledge base still links to
Freshworks. **On 2026-11-07 it did: every link was clean, but every image was
Freshdesk's.** Since 2026-11-08 every image is ours (PR 1). This file records what was measured, what has to land before the Freshdesk
account is closed, and in what order, because several of the items only work
one way round: an image copied after the account is gone cannot be copied, and
a domain pointed here before the legacy redirects work sends every old link to
a 404.

It covers the knowledge base and what sends a reader from it, or about it, into
Freshworks. The Meta side of the cutover — whether Freshchat is still
Messenger's primary receiver — is §5.1 of `docs/PROJECT-STATE.md` and is not repeated here;
it is one line in the checklist.

## Where it stands, 2026-11-12

**Every pull request this plan needed before the disconnection is live, and
`support.shipblu.com` answers from this app.** What is left: setting
`KB_PUBLIC_HOST`, deciding whether to run the import once more, writing the
domain into `render.yaml`, the items other teams own, and what waits for the
account to close.

- **PRs 1 to 5 are in production**, with the fixes from PR 5's review (#504):
  PR 1 in #497 (`918ac12`, 2026-11-08), PRs 2, 3 and 4 in #502 (`932e8ea`,
  2026-11-10), and PR 5 with #504 in #508 (`7605993`, all six services live by
  14:19:54 UTC on 2026-11-11). PR 6 waits for the disconnection.
- **The domain moved on 2026-11-11.** The CNAME's TTL already read 1800 at
  13:44 UTC. The CNAME was switched between 19:30, when Freshdesk last
  answered there, and 20:54:12, when the web service logged its first request
  for the host. By 20:58 resolvers answered `shipblu-support.onrender.com`,
  with a TTL of 14400 again. Freshdesk's copy of the knowledge base is no longer
  reachable there. Of the 58 legacy article ids, 54 answer with a 301 to an
  article that answers 200, and the 4 agents-only ones answer 404. Every
  outside link in the tables below now lands here: the phone's nine ids, the
  dashboard's 16 links, and the "Support" links on shipblu.com, go.shipblu.com
  and the App Store listing.
- **`KB_PUBLIC_HOST` is not set to the domain yet. That is the next step.**
  Until it is, `support.shipblu.com` is served as a console host rather than
  as the help centre's: on 2026-11-12 at 08:50 UTC, `/inbox` there answered
  307 to `/login`, and so did Freshdesk's own bookmarks, `/support/home` and
  `/support/tickets/new`. The widget's `BASE`, the sitemap, the `Sitemap:`
  line in `robots.txt` and every canonical still name the Render host.
- **A way back to Freshdesk is now slow.** It would mean pointing the CNAME
  back, and with the TTL at 14400 again, that takes up to four hours to reach
  resolvers that cached the new answer.
- **Outside this repository** ([the to-dos](#to-dos-outside-this-repository)),
  six items are open: `KB_PUBLIC_HOST` (above), the phone's quick replies,
  the dashboard (its 16 help links, which still depend on the legacy route,
  its 2 links to an older Freshdesk account that 404, and its Freshchat and
  Zendesk widgets), where mail is delivered, the article wording and
  Messenger's swap.
- **After the disconnection** come PR 6, SPF, a re-run of the audit, and the
  date in `docs/PROJECT-STATE.md`.

**Found on the way, and not part of this plan:**

- The favicon is behind sign-in on every host. `app/icon.svg` is not in
  `proxy.ts`'s public prefixes, so `/icon.svg` answers a signed-out visitor
  with 307 to `/login`. Once `KB_PUBLIC_HOST` is set, the help-centre host
  will rewrite it to `/help/icon.svg`, which does not exist.
- Freshdesk's portal paths that are not an article or a folder will become the
  help centre's 404 once `KB_PUBLIC_HOST` is set: `/support/home`,
  `/support/tickets/new`, `/support/login` and `/support/solutions`. Freshdesk
  sent its own `/` to `/support/home` and then to `/ar/support/home`, so those
  are the URLs bookmarks hold, and `/ar/support/home` already answers the help
  centre's 404. A redirect to the locale's home page would keep the people who
  arrive that way.

Measured read-only on 2026-11-11 and 2026-11-12, the same way as on
2026-11-07: Render's deploys and logs, the production database, every public
host by `curl`, and the repository. As before, a second sweep re-checked each
finding and tried to refute it. The sections that follow are the 2026-11-07
audit. Each subsection that has changed since carries a dated note, and the
PR sections below say what was fixed and how it was checked.

## How it was measured

Read-only, 2026-11-06 and 2026-11-07, against production
(`nqbcfnvqqyqawmffgiql`, the web service on `f89d7c1`). Four separate sweeps:
the database, the help centre as a browser receives it (all 114 sitemap URLs
and every other page type, full navigations only, never `?_rsc=` prefetches),
the code and seed content, and the widget plus every host the articles link
to. Each finding was then reproduced by a second, independent check that set
out to refute it, and a last pass looked for surfaces nobody had covered. Every
finding below survived. The queries under [Re-running this audit](#re-running-this-audit)
reproduce the headline numbers in one call.

"Freshworks" meant any Freshworks host (`*.freshdesk.com`, `cdn.freshdesk.com`
and its S3 bucket, `*.freshworks.com`, `*.myfreshworks.com`, `*.freshchat.com`,
`fw-cdn.com`, `fwcdn`, `fwusercontent`, Freshservice, Freshsales), Freshdesk's
path shapes on any host (`/support/solutions/…`, `/a/solutions/articles/…`,
`/support/home`, `/support/tickets/…`, `/helpdesk/attachments/…`), and
**`support.shipblu.com`**, which is ShipBlu's name but a CNAME of
`26fea1969c270a19570d78acb7c4fe5d.freshdesk.com` (TTL 14400) and answers as
Freshdesk: `/` is `302 → /support/home`. That held until the domain moved on
2026-11-11.

**A clean `normalise_kb_formatting` run is not evidence that no Freshdesk link
remains.** `rewriteLegacyArticleLinks` (`lib/kb/format.ts`) recognises one
shape, `…/solutions/articles/<id>`, and leaves an id it cannot resolve as it
was. Only a SELECT on the host answers the question.

## What production held on 2026-11-07

### Blocking: every image in the knowledge base is Freshdesk's

_Fixed by PR 1 (#497), live on 2026-11-08: every picture is a `kb_images` row
named by its route, and the audit counts 0 Freshdesk images in articles and in
versions._

- **214 `<img>` in 61 of the 112 articles** (109 in 30 Arabic, 105 in 31
  English), and **every one** is
  `https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/…`.
  The knowledge base holds no image on any other host. 207 distinct URLs (7 are
  shared by two articles), 28.8 MiB, 205 PNG and 2 JPEG, uploaded between
  2024-10 and 2026-01. All 207 answered 200 on 2026-11-07.
- They load on the help-centre article page
  (`app/help/[locale]/a/[article]/page.tsx`), in the widget's article panel
  (`/api/widget/article`, drawn by `app/widget/article.tsx`), and in the
  console's article view and editor preview. Every one of the 61 articles is
  public, in a public folder, with no role floor. The four articles in
  `agents_only` folders hold no image. They are not handbook articles: each is
  an empty Arabic placeholder titled «مقالة جديدة», with no English translation.
- `packaging-guidelines` and `إرشادات-التعبئة-والتغليف` are images and nothing
  else (15 each, §7 of `docs/PROJECT-STATE.md`), so those two go blank rather
  than lose their pictures.
- **Why they are there:** the importer stores the article HTML Freshdesk gives
  it (`articleBody(article.description)` in
  `worker/handlers/import-freshdesk-kb.ts`), and the article sanitiser allows
  `img src` on any `http`/`https` host (`sanitiseArticleHtml` in
  `lib/html/sanitize.ts`). Nothing anywhere downloads or re-hosts an image, and
  the console editor is an HTML source field with no upload, so a screenshot
  added to a new article has to be hot-linked from somewhere too.
- `kb_article_versions` holds the same 214 images in 61 rows. Copying the
  pictures and rewriting only `kb_articles` would let any later Restore put a
  Freshdesk URL back.

Whether Freshdesk's bucket keeps serving these files after the account is
closed or downgraded cannot be tested in advance. Plan for it not to.

### Latent: three ways a Freshdesk link comes back into an article

_Closed by PR 2 (#502), live on 2026-11-10. Save, Restore and the import now
point Freshdesk's links and pictures here as they write (`pointedHere`). Save
and Restore also refuse to add a Freshdesk reference that has no home here.
See PR 2 below._

None of these is live today. Each is one ordinary action away from putting
Freshdesk links back on the public help centre.

1. **Restore.** 18 version rows hold the 29 Freshdesk links that
   `normalise_kb_formatting` rewrote on 2026-09-03: 27 to
   `support.shipblu.com/…/solutions/articles/<id>` and 2 to the Freshdesk agent
   console (`shipblu72137318794432249.freshdesk.com/a/solutions/articles/…`).
   Each is version 1 and the only version of its article, cut by that job.
   `restoreVersion` (`app/(console)/kb/actions.ts`) re-derives the body through
   `articleBody`, which sanitises and normalises but never calls
   `rewriteLegacyArticleLinks`, so one Restore by anybody holding `kb.edit`
   republishes that article's links. The version list shows titles only, so
   nothing warns them. For all 108 versioned articles, Restore can only go back
   to the raw Freshdesk import.
2. **Re-import.** One click on `/admin/import` enqueues `import_freshdesk_kb`.
   It re-derives every body from Freshdesk, which carries the absolute links,
   so `changesNothing` is false for those 18 articles and the UPDATE runs, with
   no version cut. It also writes the CDN images back over anything re-hosted.
   Whether the click works today depends on `FRESHDESK_DOMAIN` and
   `FRESHDESK_API_KEY` still being set on the worker (`render.yaml` says "They
   can go once the migration is done"); their values were not readable. The
   jobs table holds no `import_freshdesk_kb` row and the worker's logs for 30
   days show no run. `plans/kb-article-stats.md` still names a re-run as a
   cutover job, so the ordering in the checklist below matters.
3. **Save.** Nothing on any write path — the console save, the importer,
   Restore — refuses or flags an `href` or `src` on a Freshworks host or a
   Freshdesk path shape.

### Blocking the domain move: Freshdesk's old URLs 404 here

_Fixed by PR 3 (#502), live on 2026-11-10. On 2026-11-11 all six shapes
answered 301 on the Render host and on `support.shipblu.com`. The 4
agents-only articles answer 404 (#504). See PR 3 below._

Every legacy shape `proxy.ts` sends to `/help/legacy` answers **404**:
`/support/solutions/articles/<id>`, the same with a `-title` suffix,
`/a/solutions/articles/<id>`, `/solutions/articles/<id>`,
`/<locale>/support/solutions/articles/<id>` and `/support/solutions/folders/<id>`.
The same route called directly answers the correct 301:

```text
GET /support/solutions/articles/154000189336                      → 404
GET /help/legacy?path=%2Fsupport%2Fsolutions%2Farticles%2F154000189336 → 301 /ar/a/إرشادات-التعبئة-والتغليف
```

The route reads `new URL(request.url).searchParams.get('path')`, and through the
proxy's rewrite it apparently does not see the `path` the rewrite added. That
is observed, not yet diagnosed. `kb_redirects` (174 rows: 58 ids under each of
the three prefixes, every `to_path` null) and the importer's stored ids are the
mapping, and nothing reaches it this way. This is the inbound side, not a link
we publish, but it decides what happens to every Freshdesk URL in the next
section once `support.shipblu.com` points here: today they would all 404.
`docs/PROJECT-STATE.md` §5.2 said none of these redirects had been "followed in
anger"; now one has, and it failed.

### Outside this repository: what still sends people to Freshdesk

None of these is a link stored in the knowledge base, and none is fixed by a
change to this repository. They are what a reader meets when they follow the
knowledge base, or what the team and the product hand customers in its place.

**The phone's quick replies.** 32 outbound WhatsApp messages in 27
conversations, 2026-10-07 to 2026-11-11, send customers the Freshdesk copy of
articles this help centre already serves. There were 30 in 26 when this plan
was written, and **5 fell in the 7 days to 2026-11-11 10:49 UTC**. All are
echoes typed in the WhatsApp Business app on one coexistence number ("Nayera
Mohamed" in `/admin/channels`): outbound, no author, `meta.echo` true. The
other two coexistence numbers and the support number sent none. Nothing the
console sends carries one, and the phone has never sent a link to this help
centre. Every id has an equivalent here (re-measured 2026-11-11; no new id):

| Freshdesk id | Sent | Last sent  | Same article here                                                                                                                     |
| ------------ | ---: | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 154000228261 |    7 | 2026-11-10 | `ar/شحن-محفظتك-بشيب-بلو`, `en/charge-shipblu-wallet`                                                                                  |
| 154000190910 |    5 | 2026-11-04 | `ar/كيفية-إنشاء-أوردر-إرجاع-فردي`, `en/how-to-create-a-single-return-order`                                                           |
| 154000190907 |    5 | 2026-11-11 | `ar/كيفية-إنشاء-أوردر-توصيل-فردي`, `en/how-to-create-a-single-delivery-order`                                                         |
| 154000196089 |    4 | 2026-11-05 | `ar/كيفية-تسجيل-حساب-بنكي-أو-محفظة-إلكترونية-لتحويل-التحصيلات-الإسبوعية`, `en/how-to-register-a-payout-method-for-my-weekly-transfer` |
| 154000207426 |    4 | 2026-10-22 | `ar/كيفية-إنشاء-اوردر-استبدال-فردي`, `en/how-to-create-a-single-exchange-request`                                                     |
| 154000245150 |    2 | 2026-11-02 | `ar/التجزئة`, `en/try-buy`                                                                                                            |
| 154000216183 |    2 | 2026-10-31 | `ar/السحب-الفوري`, `en/instant-payout`                                                                                                |
| 154000217447 |    2 | 2026-11-02 | `ar/شوبيفاي`, `en/shopify`                                                                                                            |
| 154000207438 |    1 | 2026-10-14 | `ar/تحميل-طلبات-متعددة-توصيل،-إرجاع،-إستبدال،-تحصيل-نقدي`, `en/upload-multiple-orders-delivery-return-exchange-cash-collection`       |

All nine were sent with Arabic links. A link here is `/<locale>/a/<slug>` on
whichever host the help centre is served from.

Since the domain moved, each of the nine links answers with a 301 to its
article here, so a customer who follows one reaches the right page. The
replies still show Freshdesk's path, and they still depend on the legacy
route.

**A 0 on the audit's `phone/app sends, 7 days` row does not by itself mean the
replies changed.** Old sends age out of the window: with no new send, the
row read 4 from 11:22 UTC on 2026-11-11, falls to 2 after 09:37 UTC on
2026-11-12, and reaches 0 after 10:14 UTC on 2026-11-18. A 0 means something
only once the phone has carried a normal week of traffic.

**The merchant dashboard, app.shipblu.com** (release v3.44.1 on 2026-11-11;
v3.43.2 when this plan was written, with the same links). 16 in-product help
links open the Freshdesk copy of 8 articles. 2 more link to an older Freshdesk
account (`shipblu.freshdesk.com/a/solutions/articles/80001070415`), and that
link 404s. Since the domain moved, all 16 answer with a 301 to their article
here. The older account's 2 links are still dead. The newer merchant app on
`merchant-web-production.onrender.com` (v3.45.3) is clean, and loads this
app's widget (`supportWidgetUrl`).

| Freshdesk id | Same article here                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 154000189336 | `ar/إرشادات-التعبئة-والتغليف`, `en/packaging-guidelines`                                                                        |
| 154000196090 | `ar/دورة-تحويل-التحصيلات`, `en/billing-days-transfer-cycle-and-fees`                                                            |
| 154000207438 | `ar/تحميل-طلبات-متعددة-توصيل،-إرجاع،-إستبدال،-تحصيل-نقدي`, `en/upload-multiple-orders-delivery-return-exchange-cash-collection` |
| 154000209749 | `ar/شروط-واحكام-الاشتراك-بباقات-التأمين`, `en/shipblu-shield-plans-terms-conditions`                                            |
| 154000217447 | `ar/شوبيفاي`, `en/shopify`                                                                                                      |
| 154000222386 | `ar/ووكومرس`, `en/woocommerce`                                                                                                  |
| 154000223217 | `ar/زامت`, `en/zammit`                                                                                                          |
| 154000223977 | `ar/ماجنتو`, `en/magento`                                                                                                       |

The dashboard also loads the **Freshchat widget**
(`fw-cdn.com/11720815/4351362.js`, which still answered 200 on 2026-11-11) for
every signed-in merchant, with no flag in front of it. Its `index.html`, last
modified on 2026-11-09, also loads a **Zendesk Web Widget**
(`shipblu.zendesk.com`, with ticket submission and chat) on every page,
whether a merchant is signed in or not. shipblu.com loads the same Zendesk
widget. Neither was in the 2026-11-07 sweep.

That matters to the knowledge base because **16 public articles** tell readers
to contact support by chat. Two of them, `en/claims-procedure` and
`ar/سياسات-وإجراءات-التعويض`, say the chat is in the merchant's ShipBlu
account. The other 14 say "live chat", "chat" or «الشات المباشر» without
saying where. `en/where-s-my-package` and `ar/شحنتي-فين؟` speak to parcel
recipients and mention the myBlu app. The 2026-11-07 count was 15;
no article's text has changed since, so that count missed one, most likely an
English article that says "chat" without "live". Until the dashboard embeds
this app's widget (`docs/embedding-the-widget.md`), a merchant who looks for
the chat in the dashboard finds Freshchat or Zendesk. The 16 articles are:

- **Arabic (8):** `إزاي-أعيد-توصيل-الأوردر-للعميل؟`, `التواصل-مع-الدعم-الفني`,
  `التواصل-مع-الدعم-الفني-2`, `المندوب-لم-يسلم-الاوردر-بعد`,
  `سياسات-وإجراءات-التعويض`, `شحنتي-فين؟`, `طلبات-الإسترداد` and
  `هل-استطيع-الحصول-ع-فواتير-ضريبية-إلكترونية؟`.
- **English (8):** `can-i-get-electronic-tax-invoices`, `claims-procedure`,
  `how-can-i-re-deliver-the-order-to-the-customer`,
  `i-did-not-recieve-my-order-yet`, `myblu-refund-request-form`,
  `reaching-client-support-team`, `reaching-client-support-team-2` and
  `where-s-my-package`.

**One click from an article.** 10 article links lead to pages whose "Support"
link is `https://support.shipblu.com/`: 4 to shipblu.com (3 such links per
page), 2 to go.shipblu.com (2 in its script bundle), and 4 to the myBlu App
Store listing (its support URL; version 4.0.6, released 2026-11-08). All three
still say so on 2026-11-11. Since the domain moved, that URL answers 307 to
`/ar` here. The Google Play listing, the Shopify app listing,
docs.shipblu.com and the Zoho links are clean.

**The parallel copy is gone.** Until 2026-11-11, `support.shipblu.com` published
the whole knowledge base from Freshdesk, and every link above landed on it. On
2026-11-11, at 19:30 UTC, 54 of the 58 legacy ids still answered 200 there,
and the 4 agents-only ones answered 302 to Freshdesk's login. From 20:54
the host answers from this app (above).

**The addresses customers are given.** The help centre's only contact link is
`mailto:support@shipblu.com` (footer, home page, tracking page).
`help@shipblu.com` appears in 15 articles: the Arabic chat articles above
except `هل-استطيع-…`, the English ones except
`can-i-get-electronic-tax-invoices`, and `en/shipblu-shield-plans-terms-conditions`.
Only `en/myblu-refund-request-form` links to it as a `mailto:`.
`tech@shipblu.com` appears in 2 more articles, `ar/ماجنتو` and `en/magento`.
§6.41 of `docs/PROJECT-STATE.md` records that only `help-support@shipblu.com`
is forwarded into this app. Where the other three addresses deliver is set in
Zoho, which receives the domain's mail (MX `mx.zoho.com`), and nobody has read
it. On 2026-11-12 the SPF record still read
`v=spf1 include:zoho.com include:_spf.google.com include:email.freshdesk.com include:_spf.odoo.com ~all`.
Treat all three addresses as "probably Freshdesk" until somebody reads the
routing.

**Wording.** `en/file-a-claim` and `ar/الشحنات-التالفة` send readers to "our
Support Portal" / "بوابة الدعم", without a link. The only portal customers know
by that name is `support.shipblu.com`, which is now this help centre, so the
phrase now points at the right place by accident. Unchanged on 2026-11-11.

### Configuration

- **`KB_PUBLIC_HOST` on the web service no longer names `support.shipblu.com`.**
  The widget script, the sitemap's 114 `<loc>`, `robots.txt`, every canonical,
  hreflang and JSON-LD URL are on `shipblu-support.onrender.com`, and the
  console is still served there, so the variable is unset or names the Render
  host. Read from output, not from the dashboard. `docs/PROJECT-STATE.md` §5.1
  said otherwise until this change. _Still true of the web service on
  2026-11-12, after the domain moved. Since the 2026-11-07 audit the
  environment has changed three times, all from the dashboard, and each change
  redeployed all six services: at 08:39:58 UTC on 2026-11-10, and at 16:08:37
  and 17:59:50 on 2026-11-11. (It also changed on 2026-11-04 and twice on
  2026-11-05.) Which variables changed cannot be read, but none of the three
  set this one to `support.shipblu.com` on the web service._
- **The blueprint lists `KB_PUBLIC_HOST` in `shipblu-support-production`,**
  which the web service and the worker both link, with no service-level entry
  on either. So one dashboard value serves both services, unless somebody added
  an override that the blueprint does not show.
- **The worker's value is unverified,** and it builds the CSAT survey links
  (`lib/csat/index.ts`) and the portal emails (`lib/portal/emails.ts`). The only
  survey ever created, on 2026-08-31, carried a `support.shipblu.com` link. It
  is dormant: CSAT is switched off, `csat_surveys` holds that one row and
  `contact_tokens` none. The admin CSAT page reads the web service's value, so
  it would not show the worker's.
- Two links built by this app on `support.shipblu.com` were delivered in August
  (one agent reply, one CSAT invitation) and answered 404 while that host
  served Freshdesk. Since the move, the reply's article link answers 200 there;
  the survey's token was not tried. Nothing to do; nothing like them has been
  sent since 2026-08-31.

### Clean

What was checked and found nothing, so it need not be checked again unless it
changes:

- **Every link in every article.** 58 `href` in 36 articles: 29 relative
  `/<locale>/a/<slug>`, all resolving to published articles, and the rest on
  play.google.com, apps.apple.com, apps.shopify.com, shipblu.com,
  go.shipblu.com, docs.shipblu.com, sheet.zohopublic.com,
  workdrive.zohoexternal.com and `mailto:help@shipblu.com`. No `srcset`,
  `data-*`, `style`, `url()`, iframe, video, script or embed in any body; no
  entity-encoded, percent-encoded, protocol-relative or `http://` link.
- Titles, slugs, excerpts, `body_text`, tags and `seo` on all 112 articles;
  names and descriptions on the 20 folders and 5 categories; `kb_redirects`'
  targets; `kb_article_feedback` and `kb_article_stats`. The `freshdesk` value
  of `source_system` on articles, folders and categories is provenance, not a
  link.
- Every page the help centre serves: both homes, 4 categories, 16 folders, 108
  articles, search, tracking, sign-in and register, the CSAT preview and the
  not-found pages, including their `<link>`, `<meta>`, JSON-LD, inline styles,
  flight payload, script bundles and response headers. No page has
  `og:image`. The only "Freshchat" in anything served is a comment in
  `/widget/embed.js` (`app/widget/embed.js/route.ts`), which loads nothing.
- The widget iframe, `/api/widget/search` and `/api/widget/article` (all 108
  articles; the images aside, clean), and the console's knowledge panel, which
  reads `body_text` and inserts a `requestBaseUrl()` link.
- Seed content: `lib/kb/handbook.ts`, `lib/tickets/canned-library.ts` (its test
  refuses any URL), `db/sql/`, `db/baseline.ts`. Production's 62 canned
  responses, the auto-response and `channels.config`.
- Static assets: self-hosted fonts and art only. `next.config.ts` sets no
  `images.remotePatterns`, so `/_next/image` does not proxy Freshdesk's files.
- A whole-schema scan of every text, varchar, jsonb and array column in
  `public`: hits only in `kb_articles.body_html` (the images),
  `kb_article_versions.body_html` and `kb_redirects.from_path`.
- Staging's database holds no knowledge base rows.

## Follow-up pull requests

In the order they should land. Each goes into `dev`. Production has it once
`dev` is merged into `main`, which deploys every service by itself once the
checks on `main` pass. So "deployed" below means that merge, checked on the
running service, not the merge into `dev`.

### 1. Host the knowledge base's images here — blocking

The only change that makes "the knowledge base does not depend on Freshdesk"
true, and the only one that cannot be done once the account is closed.

- **Storage.** The existing private bucket, at a path built from an id we
  generate (`kb/<uuid>.<ext>`), never from Freshdesk's filename: AGENTS.md's
  attachment rule. A small table, say `kb_images` (id, storage path, content
  type read from the bytes, size, sha256, the Freshdesk URL it replaced, unique
  on both of the last two so a second run copies nothing), gets RLS from the
  `db/sql/` loop like every new table.
- **Serving.** A public route under `/api/kb/` — already in `PUBLIC_PREFIXES`,
  and `/api` passes through on the help-centre host, so one relative
  `/api/kb/images/<id>` works on the custom domain, on the Render URL, inside the
  widget's iframe and in the console, as `articlePath` does for links. Redirect
  to a signed URL, as `app/api/widget/attachments/[id]/route.ts` does, rather
  than making a bucket public; the PR decides how long the signature lives and
  how it is cached, since these images are public and an article page asks for
  up to 15 at once. Raster types only, judged from the bytes; all 207 today are
  PNG or JPEG.
- **The job**, `rehost_kb_images`, strict payload with `dryRun`, `limit` and
  `locale`, enqueued without a `dedupeKey` (it is idempotent and must be
  re-runnable). It downloads each distinct Freshdesk URL with a deadline
  (`sizedTimeout`), stores it, and rewrites `src` in `kb_articles` — cutting a
  version first, as `normalise_kb_formatting` does — **and in
  `kb_article_versions` in place**, since the picture is the same and only its
  address moves. A file that fails to download keeps its old URL and is
  reported by name; the job never drops an `<img>`. It tallies per locale.
  `JobType`, `JOB_PAYLOADS`, the handler registry and
  `scripts/ci/db-jobs.txt` (`run: rehost_kb_images dryRun=true`) in the same
  change.
- **Verified by** the audit query's two `images` rows answering 0, every
  `kb_images` row's route answering an image, and the 61 article pages fetched
  on full navigations showing the same number of images as before.
- **Rolled back by** Restore on the versions the job cut. The Freshdesk URLs
  keep working until the account is closed, so a rollback before then loses
  nothing; after it, there is no rollback, which is why it runs first.

**What was built, and the two places it departs from the above.** The code is
in `lib/kb/image-src.ts` (reading and rewriting `src` in stored HTML),
`lib/kb/images.ts` (the download, the type read from the bytes, the copy, the
signed URL), `worker/handlers/rehost-kb-images.ts` and
`app/api/kb/images/[id]/route.ts`, with migration `0061_kb_images`.

- **No version is cut; versions are rewritten in place, and the way back is
  `revert=true`.** A version cut per article would hold the Freshdesk address,
  which is the Restore hazard this plan lists first, created 61 times over. It
  would also keep the audit's `images, versions` row above 0, which is this
  PR's own check. And the help centre dates an article by its newest version
  (`editedAt`), so 61 articles would read "updated today" for a change no
  reader can see. `kb_images.source_url` already records the address each copy
  replaced, so `rehost_kb_images revert=true` (dry-runnable) writes those
  addresses back into every article and version that names a copy. Like the
  plan's rollback, it works only while Freshdesk still serves the originals.
- **`sha256` is recorded, not unique.** Two Freshdesk URLs holding the same
  bytes would have needed a second table to keep both addresses for the way
  back. The second run is kept from copying again by `source_url` being
  unique.
- **Serving.** A picture goes to whoever may read an article that shows it.
  One shown by a published article a stranger can read (all 61 on 2026-11-08)
  is signed for 24 hours, the signature reused while 12 hours remain (in
  memory, per process), and the redirect cacheable by anybody for an hour. So
  after the first reader, an article page's fifteen pictures cost no query and
  no Storage call. Any other picture is signed for five minutes, per request,
  with private caching. It goes to a console agent, or to a signed-in
  customer an article visible to them shows it to. Everybody else gets 404.
  Only a cache miss is rate limited (600 a minute per address). A Storage
  failure is logged and answered 502, uncached.
- **Save and Restore keep the copies.** The console's Save and Restore map any
  Freshdesk address already copied to its copy as the body is written
  (`withCopiedImages`). So an editor tab opened before the job ran, or a
  version cut before it, cannot put Freshdesk back. PR 2 does the same for the
  importer.
- **What it downloads.** It selects by the audit query's own pattern, so
  everything the check counts is in scope. It downloads only over HTTPS, from
  a Freshworks domain or from Freshdesk's bucket on S3, matched as the whole
  host. It follows no redirect at all, so it never asks a host a redirect
  names. It stops after three copies in a row that our own Storage refused.
  The cap is 10 MB, and the type must be PNG, JPEG, GIF or WebP
  as read from the bytes. Anything else matching the pattern is kept and named
  in the report. Measured on 2026-11-08: 207 distinct addresses, all in
  Freshdesk's bucket, none only in a version.

To run it, after the deploy: `npm run job -- rehost_kb_images dryRun=true`
(expect `would_copy=207` and 61 articles and 61 versions to rewrite, ar and en
apart), then without `dryRun`, then `dryRun=true` again, which should end
`nothing to do`. `locale=` and `limit=` narrow a cautious first run. A failed
picture is a `kept <url>: <reason>` line and is retried by the next run. An
article saved in the console while the job ran is a `skipped <slug>` line and
is picked up by the next run.

**Run on production, 2026-11-08.** `main` took PR 1 with #497, and the web
service was live on it at 21:05 UTC. The job ran at 21:13 and copied 207
pictures in a minute: 30,171,562 bytes, PNG and JPEG. It rewrote 214 `src` in
61 articles and the same in 61 version rows, and cut no version. Measured the
next morning:

- The audit query's two `images` rows answer 0.
- `/api/kb/images/<id>` answers 307 with `public, max-age=3600` to a signed
  Storage URL, and an unknown id answers 404.
- All 207 rows answer their route with an image (205 PNG, 2 JPEG).
- A full navigation of `/en/a/action-center` draws its three pictures from the
  route and none from Freshdesk.

The 29 portal links in 18 version rows are still there. That is by design: PR
2 has been live since 2026-11-10, so a Restore of any of those versions points
the links here. All 29 name an article that was imported and is published, 12
ids in all.

**Measured again on 2026-11-11, on `7605993`.** All 207 routes answered 307
to an image, again 205 PNG and 2 JPEG. Full navigations of all 61 articles
with pictures drew all 214 from the route and none from Freshdesk. That held
on `support.shipblu.com` too, once the domain had moved.

### 2. Keep Freshdesk links from coming back

- **Restore** passes the restored body through `rewriteLegacyArticleLinks` and
  the image map, or refuses a version that still names Freshdesk, with a
  sentence saying why.
- **Save** refuses an `href` or `src` on a Freshworks host or a Freshdesk path
  shape, in the console action and anywhere else `articleBody` is fed. Not
  `support.shipblu.com` as such: once the domain moves it is ours, and
  `/<locale>/a/<slug>` there is a good link. The guard is the path shapes plus
  Freshworks' own hosts.
- **Import** either rewrites links and maps images on the way in, or is
  switched off for good. Recommended: switched off once the last run is done
  (the checklist), and retired in PR 6, because a re-import can only ever bring
  Freshdesk's copy back.
- Widen `rewriteLegacyArticleLinks`, or have the guard report what it does not
  recognise (`/support/solutions/folders/<id>`, `/support/home`,
  `/support/tickets/new`, an id with no imported row), so a clean run means
  clean.

**What was built.** `lib/kb/off-freshdesk.ts` points a body here
(`pointedHere`): a picture with a copy goes to its copy (`withCopiedImages`,
from PR 1), and a link to an article the import brought in goes to that
article (`rewriteLegacyArticleLinks`, widened to relative portal paths). Which
translation a link reaches is decided in one place for this and for
`normalise_kb_formatting` (`legacyArticleResolver` in `lib/kb/format.ts`).
`lib/kb/freshdesk-refs.ts` finds what is left and words the refusal. The
`article-off-freshdesk` repo rule holds every writer to it: an `articleBody`
call with no `pointedHere` after it fails CI.

- **A link is pointed only at a published article** (`legacyArticleIndex`).
  Pointed at a draft or an archived one, it would 404 for every reader and no
  longer look like Freshdesk's, so nothing would refuse it. Left as Freshdesk's
  address, a Save is refused for adding it. Every imported article was
  published on 2026-11-09, so no stored link changes. Visibility is not asked:
  an internal article linking to another internal one is right, and a public
  one linking to an internal one was as closed to customers on Freshdesk.
- **Only our Freshdesk is rewritten.** The rewrite asks `isFreshdeskAddress` of
  every match, as the refusal does, so a link to another company's portal with
  the same path is not turned into a link to whatever we imported under that
  id. A `#fragment` is kept; the link's text is left as the author wrote it.
- **Save and Restore** both point the body here before they write, and
  then refuse a Freshdesk link or picture the write would _add_, naming the
  address and what to do. One the stored article already carries is left
  alone. Otherwise an article whose picture the copy job could not copy could
  never be saved again, whatever the save was for, until somebody found the
  picture. Measured on 2026-11-08, all 29 links in the 18 version rows name an
  article that was imported, so Restore points every one of them here and
  refuses none.
- **Import** points the body here too, so a re-import writes our addresses
  over our addresses and, by `changesNothing`, nothing at all. A picture
  nobody has copied yet keeps Freshdesk's address for the copy job. So does a
  link to an article the run has not reached yet, for the next run or the
  formatting pass. It is not switched off in code: unsetting its two variables
  after the last run (the checklist) is the switch, and PR 6 retires it.
- **What counts as Freshdesk's** is narrower than the audit's pattern, and on
  purpose. It is Freshworks' own domains, Freshdesk's bucket (the host test
  the copy job downloads by, `onFreshworks`), a Freshdesk mailbox, and the
  portal's paths (`/support/solutions|home|tickets|discussions|topics|…`,
  `/solutions/articles|folders|categories/…`, `/helpdesk/attachments/…`) on
  `support.shipblu.com` or with no host. None of the forum or attachment shapes
  was stored on 2026-11-09. A page that only mentions Freshdesk, or another company's portal
  on its own domain, does not break when ours closes. An editor refused a
  link to one would have nothing to fix.
- **The handbook seed** runs `pointedHere` too, for the rule's sake: its
  content names nothing of Freshdesk's, so it reads nothing and changes nothing.
- **Not covered:** the formatting pass does not report a Freshdesk link it cannot resolve,
  because none is stored: the audit's `links, live` row is 0, and Save and
  Restore now refuse to add one.

**Deployed in #502** (`932e8ea`, web service live 18:16:28 UTC on 2026-11-10).
The checklist's check is the tests: on `main`, `app/(console)/kb/actions.db.test.ts`
restores a version that carries a Freshdesk link, and refuses a save that adds
one. No Save or Restore has changed an article in production since: no version
row has been cut since 2026-09-03, and no article has been updated after the
copy job at 21:14 UTC on 2026-11-08. A Save that changes nothing, or one that
is refused, leaves no trace, so this cannot say none was tried. #504, deployed
in #508, added `freshservice` to the pattern the copy job selects pictures by
(`isFreshworksImage`), so every picture Save refuses is one the copy job would
copy. The guard already refused `freshservice.com`.

### 3. Freshdesk's old URLs resolve through the proxy — blocking the domain move

The 404 above. Find why `app/help/legacy/route.ts` does not see the `path` the
rewrite adds, fix it so the route works both rewritten and called directly, and
prove the six shapes 301 on a deployed build, with a test that fails on today's
code. Record the measurement in §5.2 of `docs/PROJECT-STATE.md`.

**Diagnosed and built.** Next 16 hands a route handler the request as it
arrived. After the proxy's rewrite, `request.url` was still
`/support/solutions/articles/<id>`, measured on a production build, so the
`?path=` the rewrite added was in no URL the handler could read. The proxy now
passes the path in a request header set on the rewrite (`x-legacy-path`,
`lib/kb/legacy-path.ts`), which is how a proxy hands a value to what it
rewrites to. The route reads that header, or `?path=` on a direct call
(PROJECT-STATE §6.115).

- `proxy.test.ts` checks that each of the six shapes, on both hosts, is
  rewritten with the path in the header.
- `app/help/legacy/route.db.test.ts` builds the request Next actually hands
  the handler. Four of its cases fail against the route as it was.
- A production build served locally, on a database holding one bilingual
  imported article, answered 301 for all six shapes, where the same build of
  `dev` answered 404 for every one.
- **On the deployed build** (#502, live 2026-11-10; #504 with #508,
  2026-11-11), all six shapes answered 301 on the Render host on 2026-11-11,
  and on `support.shipblu.com` once the domain had moved. The five article
  shapes went to the article, `/en/support/…` to the English one. A folder
  whose id is a stored Freshdesk folder (`kb_folders.external_id`) went to
  `/ar`, and an unknown article or folder id answered 404. Across the 58
  imported ids, 54 answered 301 to an article that answers 200, and the 4
  agents-only ones answered 404 directly.
- The lookup is `resolveLegacyPath` (`lib/kb/legacy-resolve.ts`). An article
  link with its title after the id finds the importer's `kb_redirects` row for
  the bare id. Without that, an article first written in English answered in
  English by the bare link and in Arabic by the titled one
  (`legacy-resolve.db.test.ts`). Every production row points at an Arabic
  article today, so nothing there moves.
- Called directly, the route is `/help/legacy?path=…` on the Render host and
  `/legacy?path=…` on `KB_PUBLIC_HOST`, which puts `/help` in front of every
  path. The Freshdesk shapes themselves need no such care.
- It answers with an article some reader can open, the importer's own
  `kb_redirects` row included (`someReaderMayOpen`): published, and neither it
  nor its folder agents-only. A redirect to anything else is a dead link a
  browser keeps, where another translation may answer. The id lookup chooses
  the translation in the order every writer points a link at one
  (`legacyArticleResolver`), and a row whose article is closed answers with its
  own `to_path` when it has one.
- It answers 301 only with the article it would choose were every article
  open, and 302 while another translation or a row's `to_path` stands in for
  a closed one: a 301 to the stand-in is kept by the browser and moves the old
  URL's standing in search to it, so readers would still land there once the
  article reopened.
- On 2026-11-11 every imported article was published and 4 sat in an
  agents-only folder, Arabic only, with 3 redirect rows each. Their 12 old
  URLs answered a 301 to a page that 404s, and answer 404 from this change on.
  No other redirect moves. Measured in production once #508 was live: all 12
  answer 404, on both hosts. The four are the empty placeholders described
  under "What production held", so no reader loses any content.

### 4. Upload an image in the article editor

Not blocking the disconnection, but without it the next screenshot anybody adds
is hot-linked from somewhere else, and PR 2's guard would have nowhere to send
them. Stores through PR 1's table and route.

**What was built.** The editor's body has an Insert picture button, and takes a
picture pasted into it or dropped on it. Each goes up on its own, the moment it
is chosen, through `uploadArticlePicture` in `app/(console)/kb/actions.ts`
(`kb.edit`), and `<p><img src="/api/kb/images/<id>" alt="" /></p>` goes in
where the caret is. The article's Save is unchanged.

- **Judged by its bytes** (`storeUploadedPicture` in `lib/kb/images.ts`): PNG,
  JPEG, GIF or WebP as `kbImageType` reads them, at most 10 MB, stored under
  the type read rather than the browser's label. The editor checks the label
  and the size first, from the same list (`KB_IMAGE_TYPES` and
  `KB_IMAGE_MAX_BYTES`, moved into `lib/kb/image-src.ts` so the browser can
  read them), only to save a round trip.
- **A `kb_images` row with no `source_url`.** It replaced nothing, so
  `rehost_kb_images revert=true` reports it as `left_without_source` and leaves
  it. Once uploads exist, that dry run no longer says `nothing to do`, which is
  the truth.
- **Who sees it is PR 1's rule.** Until an article that shows it is saved, a
  picture is in no article, so only a console agent gets it; that is what lets
  the preview draw it. Once a public article is saved with it, it is public.
- **Where it goes.** At the caret when the upload answers, moved to the end of
  the top-level block the caret is in (`blockBoundaryAfter`), so a caret in the
  middle of a paragraph or inside a tag does not split it. A body never
  focused gets it at the end. Several files from one drop or one choice go up
  in turn. A second batch asked for while one runs is told to wait, and Save is
  held until the upload has answered, Enter in the title included.
- **A paste carrying text pastes the text.** Word, Excel and Sheets put a
  rendered picture of what was copied beside its text, so only a paste with no
  text (a screenshot, a copied image) is uploaded.
- **The action answers in words where the guard would redirect.** The editor
  calls it directly, and a followed redirect would take the unsaved draft
  with the page, so a signed-out or no longer permitted author is told why
  instead. It revalidates on success like any action, although no page draws
  the picture until the next Save. A shape chosen to slip past
  `action-revalidates` was the hole that rule exists to close.
- **A dropped file no longer opens in place of the console.** A drop anywhere
  on the page while the editor is open is caught, so the unsaved draft stays.
  Only a drop on the body uploads.
- PR 2's refusal for a Freshdesk picture nobody copied now says to add it again
  with Insert picture, where it could only say to remove it.

**Measured** on a production build served locally, in Chromium, with
Storage stood in for by a local server answering its upload, sign and signed
GET:

- The button, a paste and a drop each stored a PNG as `image/png` and put it
  where the caret was, and the preview drew it.
- A dropped text file was refused in words, and the page stayed where it was.
- Save stored the body with the picture.
- While the article was a draft, the picture's route answered an agent 307
  `private, max-age=240` and a stranger 404.

Real Storage and the deployed console are still to see once. The upload has
been deployed since #502 (2026-11-10), and the caret and loose-text fixes from
#504 since #508 (2026-11-11). Production holds no uploaded picture yet: on
2026-11-12, all 207 `kb_images` rows still carried a `source_url`.

**Left out:** a picture uploaded and never saved into an article stays a row
and an object that only the console can load. So does one whose insert the
admission gate gave up as lost while it committed: the author is told to try
again, and a second copy is stored beside the first. Both can be swept later
by a job that deletes rows no article or version names after a week.

### 5. The `robots.txt` sitemap line on the Render host

Side observation, not Freshworks: `robots.txt` advertises
`<base>/sitemap.xml`, which 404s on the Render host (the sitemap is
`/help/sitemap.xml` there). On the help-centre host the proxy rewrites it and it
works, so this resolves itself at the domain move; fix it only if the Render
host is meant to be crawled meanwhile.

**What was built.** `proxy.ts` sends `/robots.txt` and `/sitemap.xml` to the
help centre's two routes on every host (`CRAWLER_FILES`), as it already did a
locale path. Until the domain moves, the Render host is where the help centre's
canonicals point, so it is the host being crawled. Measured on 2026-11-10, it
answered 404 for both files. A crawler there found no robots file at all, so
`Disallow: /*/track`, which keeps the URLs carrying a parcel number out of a
crawler's logs, did not apply on the one host the help centre is served on. The
`Sitemap:` line named a sitemap that 404s. Now both answer there, on a
production build served locally:

- `/robots.txt` and `/sitemap.xml` answer 200 with no session;
- a path beneath one of them still goes to sign-in.

`proxy.test.ts` follows the `Sitemap:` line `robots.txt` writes through the
proxy, both before the domain moves and after, and checks that it reaches the
sitemap. On the help-centre host nothing changes: its catch-all rewrite already
sent both there. `/help/robots.txt` and `/help/sitemap.xml` still answer, and
nothing advertises them.

**Deployed in #508** (`7605993`, 2026-11-11). On the Render host,
`/robots.txt` and `/sitemap.xml` answer 200, and the sitemap's 114 `<loc>`
match `/help/sitemap.xml` byte for byte. They answer the same on
`support.shipblu.com` since the move. The published base is still the Render
host there (`KB_PUBLIC_HOST` unset or naming it), and so are the `Sitemap:`
line and every `<loc>`.

### 6. Retire the Freshdesk importer — after the disconnection

`import_freshdesk_kb`, its handler and test, `lib/freshdesk/`, the
`/admin/import` card that starts it, and `FRESHDESK_DOMAIN` /
`FRESHDESK_API_KEY` from `lib/env.ts` and `render.yaml`, all in one commit
(CI's `env-parity`, `job-registry` and `db-jobs` rules hold them together).
Keep `kb_redirects`, `app/help/legacy`, `freshdeskArticleId` and the
`source_system` values: they serve inbound links for as long as anybody holds
one.

**What the commit touches**, read off `dev` at `b4e2c68` on 2026-11-11:

- **The job.** `'import_freshdesk_kb'` in `JobType` (`lib/queue/index.ts`). Its
  import and registry entry in `worker/handlers/index.ts`.
  `worker/handlers/import-freshdesk-kb.ts`, with its `.test.ts` and
  `.db.test.ts`. `lib/freshdesk/` (`client.ts`, `client.test.ts`). The
  `skip: import_freshdesk_kb` line in `scripts/ci/db-jobs.txt`. Nothing else
  imports `lib/freshdesk`, and it adds no npm dependency.
  `JOB_PAYLOADS` has no entry for the job, and `.env.example` declares
  neither variable. `jobs.type` is plain text, so no migration is needed.
- **The variables.** Both are in `lib/env.ts`, and declared on the worker in
  `render.yaml` as `sync: false`. They also need deleting from the worker in
  the dashboard. Whether they are still set cannot be read.
- **The card, not the page.** `/admin/import` keeps its two backfills. Delete
  `form.tsx` (`ImportForm`) and `startFreshdeskImport` in its `actions.ts`.
  The comment there says a fixed dedupe key would be "taken forever" by the
  first run, which holds only for a run that went `dead`: cleanup frees a
  completed job's key after seven days. It goes with the card. In `page.tsx`,
  delete the card,
  `recentRuns('import_freshdesk_kb')`, `knowledgeBaseCounts()` and the header's
  "Bring the Freshdesk knowledge base in". `admin/sections.ts` describes the
  page as "The Freshdesk knowledge base import, and the backfills", with the
  keyword `freshdesk`, which `admin/settings-search.test.ts` asserts.
- **What CI refuses if only the above goes.** `setArticleStats`
  (`lib/kb/stats.ts`) is imported by the handler alone, so `dead-exports`
  refuses it. `knowledgeBaseCounts` (`lib/admin/import-status.ts`) goes with
  its cases in `lib/admin/import-status.db.test.ts`, which would otherwise
  keep it alive on their own. `tsc` refuses `'import_freshdesk_kb'` as a
  `JobType` in `lib/queue/index.db.test.ts` and
  `lib/admin/import-status.db.test.ts`. `detectCategoryLocale` and
  `looksUntranslated` (`lib/kb/language.ts`) are then used only by their test:
  CI passes, but the code is dead.
- **What goes stale without failing.** The comment in `lib/env.ts` is already
  wrong: it says an unset variable makes the job skip, but the handler throws,
  and no cron runs it. The comment in
  `worker/handlers/backfill-subcategorise-ai.ts` that leans on it is wrong in
  the same way. The "Three today" in
  `scripts/ci/rules/article-off-freshdesk.mjs` is right until PR 6 and then
  becomes two; the rule needs only two writers. In the docs: the list of body writers in AGENTS.md; the README's
  "Freshdesk import"; in `docs/PROJECT-STATE.md`, §1's "with its Freshdesk
  importer", §5.3's "The KB importer is the working model" and the passages
  that name the import's re-run; and
  `plans/help-centre-design-v02.md`'s re-import note. Find the rest with
  `git grep -n -i -E 'freshdesk import|the importer|re-import|import_freshdesk'`.
- **Keep, beyond the four above:** `proxy.ts`'s legacy section,
  `lib/kb/legacy-path.ts` and `lib/kb/legacy-resolve.ts`, which with
  `app/help/legacy` serve the inbound Freshdesk URLs: the phone's, the
  dashboard's and every old bookmark. And PR 2's `lib/kb/off-freshdesk.ts` and
  `lib/kb/freshdesk-refs.ts`, which Restore needs to point the 29 links in 18
  version rows here, with the `article-off-freshdesk` rule that keeps every
  writer on them. Once the importer goes, nothing writes `kb_redirects`, and
  nothing needs to: its 174 rows are data.

## To-dos outside this repository

The state column is as measured on 2026-11-11 and 2026-11-12.

| Owner                                | To do                                                                                                                                                                                                                                                                        | State                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render                               | Set `KB_PUBLIC_HOST=support.shipblu.com` in `shipblu-support-production` (the checklist below).                                                                                                                                                                              | **Not done, and the next step.** The web service still publishes the Render host, and serves `support.shipblu.com` as a console host.                                                                                 |
| Support lead                         | Replace the nine Freshdesk links in the Business app's quick replies on the coexistence number with the links above, and ask the team to stop pasting `support.shipblu.com/…/solutions/…` links.                                                                             | Open. 32 sends in all, 5 in the 7 days to 2026-11-11 10:49 UTC, the latest at 10:14 that day. Each link now 301s to its article here.                                                                                 |
| Support lead (console)               | Reword the chat instruction in the 16 articles listed above if the dashboard's chat is not replaced first, "Support Portal" in `en/file-a-claim` and `ar/الشحنات-التالفة`, and whichever of `help@` and `tech@` does not reach a team.                                       | Open. No article has been edited since 2026-11-08.                                                                                                                                                                    |
| Merchant dashboard (app.shipblu.com) | Point the 16 help links at this help centre (table above) and replace the Freshchat loader with this app's widget, per `docs/embedding-the-widget.md`. `app.shipblu.com` is already in the widget's `frame-ancestors`.                                                       | Open. The 16 links land here through the domain move. Freshchat is still loaded, and so is a Zendesk widget. The 2 links to the older Freshdesk account still 404.                                                    |
| Marketing site and go.shipblu.com    | Point "Support" somewhere that is not Freshdesk, or leave it on `support.shipblu.com` and let the domain move fix it.                                                                                                                                                        | Done by the domain move: `https://support.shipblu.com/` now answers 307 to `/ar` here.                                                                                                                                |
| App Store Connect                    | The myBlu listing's support URL, as above.                                                                                                                                                                                                                                   | Done by the domain move, as above.                                                                                                                                                                                    |
| Mail admin (Zoho)                    | Say where `support@shipblu.com`, `help@shipblu.com` and `tech@shipblu.com` deliver. If it is Freshdesk, forward them here or change the address the help centre gives. Remove `include:email.freshdesk.com` from SPF once Freshdesk sends nothing (after the disconnection). | Open. Nobody has read the routing. SPF still includes `email.freshdesk.com`.                                                                                                                                          |
| Meta (the Page's settings)           | Messenger's swap, per §5.1 of `docs/PROJECT-STATE.md`.                                                                                                                                                                                                                       | Not confirmed. Since 09:50 UTC on 2026-11-11, new Messenger threads have been handed to this app. Older threads still arrive in `standby`, and nothing here can read whether Freshchat is still the primary receiver. |
| DNS                                  | The `support.shipblu.com` move, in the checklist's order.                                                                                                                                                                                                                    | Done on 2026-11-11: the CNAME was switched between 19:30 and 20:54 UTC. The first request reached the web service at 20:54:12, and by 20:58 resolvers answered with the Render host.                                  |

## Checklist before Freshdesk is disconnected

Order matters. The check beside each item is what proves it, not the merge.

**Before anything is switched off**

- [ ] **The last import, if any, runs first.** If the cutover re-run in
      `plans/kb-article-stats.md` is still wanted, run `import_freshdesk_kb`
      now. Once PR 2 is deployed, the import points pictures and links here
      itself. Before it, follow it with `normalise_kb_formatting` to rewrite
      the 29 links again. After this, nothing imports: unset
      `FRESHDESK_DOMAIN` and `FRESHDESK_API_KEY` on the worker. _Check:_ the
      audit query's `links, live` row answers 0. _2026-11-12: the check
      passes, and PR 2 is deployed, so a re-run would point its pictures and
      links here. No import has run since 2026-08-19. Three of the five
      Freshdesk categories still carry that day's `updated_at`, and the
      importer stamps every category it passes. The cutover re-run was never
      queued. Whether the two variables are still set on the worker cannot be
      read. So this is still a decision: run the import once more, or let PR
      6 take the importer away._
- [x] **PR 1 is deployed and its job has run** — `dryRun=true`, then for
      real, then `dryRun=true` again reporting nothing to do. _Check:_ the
      audit query's two `images` rows answer 0; every `kb_images` row loads
      through its route. Done 2026-11-08: deployed at 21:05 UTC (#497), run
      at 21:13. On 2026-11-09 both `images` rows read 0, and all 207 rows
      answered their route with an image.
- [x] **PR 2 is deployed.** _Check:_ its tests restore a version carrying a
      Freshdesk link and save one carrying a Freshdesk `href` and `src`, and
      neither reaches `kb_articles` (staging holds no knowledge base to try it
      on). Done 2026-11-10 (#502). The tests are on `main`.
- [ ] **The phone stops sending Freshdesk links.** _Check:_ the audit query's
      `phone/app sends, 7 days` row answers 0 after a week of the phone's
      usual traffic. The row also falls to 0 by itself as old sends age out
      (above). _2026-11-11: 5 in the 7 days to 10:49 UTC, the latest at
      10:14._
- [ ] **The dashboard** links here and loads this widget, not Freshchat.
      _Check:_ no Freshworks host in app.shipblu.com's script chunks.
      _2026-11-11: its links land here through the domain move. It still
      loads Freshchat, and a Zendesk widget besides._
- [x] **The marketing site, go.shipblu.com and the App Store listing** are
      updated, or deliberately left for the domain move. Left: each "Support"
      link is still `https://support.shipblu.com/`, and since 2026-11-11 that
      URL answers 307 to `/ar` here.
- [ ] **Mail:** the three addresses customers are given (`support@`,
      `help@`, `tech@`) reach this app, or a team that answers them.
      _Check:_ a test mail to each opens a ticket here.
- [ ] **The article wording** is updated (chat in 16 articles, Support Portal
      in 2).
- [ ] **Messenger's swap** per §5.1 of `docs/PROJECT-STATE.md`. Disconnecting
      Freshworks while Freshchat still holds Messenger leaves Messenger
      unanswered. _2026-11-11: from 09:50 UTC, Meta has handed each new
      Messenger thread to this app. Threads opened before that still arrive
      in `standby`. No delivery in 30 days names Freshchat, so whether it
      still holds the inbox needs the Page's Advanced messaging settings.
      Replies typed in Business Suite on the new threads never reach the
      console (§5.1)._

**Moving `support.shipblu.com`, if the name is kept**

- [x] **PR 3 is deployed.** _Check:_ the six legacy shapes 301 on the Render
      host. Done: deployed 2026-11-10 (#502), and measured on 2026-11-11.
- [x] **Lower the CNAME's TTL** (14400 today) at least a TTL ahead. It
      already read 1800 at 13:44 UTC on 2026-11-11, more than one 14400 s TTL
      before the switch (after 19:30), and has been 14400 again since the
      switch.
- [x] **Add `support.shipblu.com` as a custom domain** on the
      `shipblu-support` web service, then switch the CNAME and wait for the
      certificate. Done 2026-11-11. The web service logged its first request
      for the host at 20:54:12 UTC, and HTTPS answers there.
- [ ] **Write the domain into `render.yaml`.** It was added in the
      dashboard, and the blueprint declares no `domains:` for
      `shipblu-support`, so the file no longer describes the running service
      (AGENTS.md, **Land config in the repo too**). Its own small change into
      `dev`: `render.yaml` reaches production by the merge into `main`, and a
      Blueprint sync applies what it says (`docs/PROJECT-STATE.md` §2). Say
      so in §2's service table in the same change.
- [ ] **Only then** set `KB_PUBLIC_HOST=support.shipblu.com` — a bare
      hostname, because `proxy.ts` compares it with `Host` as written — on the
      web service **and** the worker, which builds the survey and portal-email
      links, and redeploy both. Set before the DNS answers here, it repeats
      August: every published URL on a host that serves Freshdesk. The
      blueprint keeps it in `shipblu-support-production`, which both services
      link, so one change to the group covers both, and Render redeploys every
      service that links it. That holds unless either service carries its own
      entry, set in the dashboard, which would win over the group and which
      the blueprint does not show: look at each service's Environment page
      when setting it. **Open on 2026-11-12, and the DNS answers here, so
      nothing stands in the way.**
- [ ] _Check:_ `/widget/embed.js`'s `BASE`, the sitemap and the canonicals name
      `support.shipblu.com`; `/en/a/packaging-guidelines` answers 200 there; a
      Freshdesk URL from the tables above 301s to its article; `/inbox` there
      is the help centre's 404, not the console. _2026-11-12, before the
      variable: the article answers 200 and the Freshdesk URLs 301. `BASE`,
      the sitemap and the canonicals name the Render host, and `/inbox` goes
      to the console's sign-in._

**After the disconnection**

- [ ] Re-run [the audit](#re-running-this-audit) and get zeros where it says.
      `links, versions` stays at 29 in 18 rows, by design: those are the old
      versions, and a Restore points each link here.
- [ ] Every `kb_images` row's route still answers an image — proof the copies,
      not Freshdesk's bucket, are what the pages load.
- [ ] PR 6. Remove Freshdesk from SPF.
- [ ] `rehost_kb_images revert=true` stops being a way back: it would write
      addresses that no longer serve anything. The job's payload says so
      (`lib/queue/payloads.ts`), and AGENTS.md since 2026-11-12. Take the
      option out with PR 6, or leave it with that warning.
- [ ] `docs/PROJECT-STATE.md` §1 and §5.1 say Freshdesk is gone, with the date.

## Re-running this audit

One call answers the headline numbers. On 2026-11-07 it returned images 214
in 61 rows in both tables, links 0 live and 29 in 18 version rows, and 5
Freshdesk links sent from the phone in the last 7 days (30 in all). On
2026-11-12 at 08:50 UTC it returned images 0 and 0, links 0 live and 29 in 18
version rows, and 4 phone sends in the last 7 days (32 in all).

What "zeros where it says" means after the disconnection:

- **Must be 0:** both `images` rows and `links, live`.
- **Stays at 29 in 18 rows, by design:** `links, versions`. Those are the old
  versions. All 29 name a published imported article, so a Restore points
  each one here.
- **Reaches 0 by itself:** `phone/app sends, 7 days`, as old sends age out. It
  proves the quick replies changed only after a normal week of the phone's
  traffic.
- **Should not fall:** `phone/app sends, all time`, which counts history. It
  drops only if one of those conversations is purged.

The link patterns no longer name `support.shipblu.com`, since the domain is
ours: a `/<locale>/a/<slug>` link there is a good one. The path alternatives
are the portal shapes Save refuses (`PORTAL_PATH` in
`lib/kb/freshdesk-refs.ts`), so they catch every Freshdesk shape on that host.
On 2026-11-12 this pattern counted exactly what the old one did, because
nothing of the other shapes is stored.

```sql
select 'images, live' as what, count(*) as n, count(distinct a.id) as rows_
from kb_articles a, regexp_matches(a.body_html, '<img[^>]*src="([^"]*)"', 'gi') m
where m[1] ~* '(freshdesk|freshworks|freshchat|freshservice|fwcdn|fw-cdn|fwusercontent)'
union all
select 'images, versions', count(*), count(distinct v.id)
from kb_article_versions v, regexp_matches(v.body_html, '<img[^>]*src="([^"]*)"', 'gi') m
where m[1] ~* '(freshdesk|freshworks|freshchat|freshservice|fwcdn|fw-cdn|fwusercontent)'
union all
select 'links, live', count(*), count(distinct a.id)
from kb_articles a, regexp_matches(a.body_html, 'href="([^"]*)"', 'gi') m
where m[1] ~* '(fresh(desk|works|chat|service)|myfreshworks|fwcdn|fw-cdn|/solutions/(articles|folders|categories)(/|$)|/support/(solutions|home|tickets|login|search|signup|profile|discussions|topics)(/|$)|/helpdesk/attachments(/|$))'
union all
select 'links, versions', count(*), count(distinct v.id)
from kb_article_versions v, regexp_matches(v.body_html, 'href="([^"]*)"', 'gi') m
where m[1] ~* '(fresh(desk|works|chat|service)|myfreshworks|fwcdn|fw-cdn|/solutions/(articles|folders|categories)(/|$)|/support/(solutions|home|tickets|login|search|signup|profile|discussions|topics)(/|$)|/helpdesk/attachments(/|$))'
union all
select 'phone/app sends, 7 days', count(*), count(distinct conversation_id)
from messages
where direction = 'outbound' and created_at > now() - interval '7 days'
  and body_text ~* '(support\.shipblu\.com/[a-z]{2}/support/|[a-z0-9-]+\.freshdesk\.com)'
union all
select 'phone/app sends, all time', count(*), count(distinct conversation_id)
from messages
where direction = 'outbound'
  and body_text ~* '(support\.shipblu\.com/[a-z]{2}/support/|[a-z0-9-]+\.freshdesk\.com)';
```

From a shell:

```bash
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://support.shipblu.com/
```

Until 2026-11-11, `302 https://support.shipblu.com/support/home`, which was
Freshdesk. Since the move, `307 https://support.shipblu.com/ar`, which is this
app.

```bash
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://support.shipblu.com/support/solutions/articles/154000189336
```

`301` to the article; the same path on `shipblu-support.onrender.com` answers
the same. It was `404` on the Render host on 2026-11-07, before PR 3.

```bash
curl -sS https://support.shipblu.com/widget/embed.js | grep -o 'var BASE = "[^"]*"'
```

On 2026-11-12, `https://shipblu-support.onrender.com`. Once `KB_PUBLIC_HOST` is
set, it should read `https://support.shipblu.com`.

```bash
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://support.shipblu.com/inbox
```

On 2026-11-12, `307` to `/login`: the console, because `KB_PUBLIC_HOST` is not
set. It should become the help centre's `404`.
