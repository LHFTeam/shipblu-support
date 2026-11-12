# Disconnecting Freshdesk: what still depends on it, and the order to undo it

The question was whether anything in the knowledge base still links to
Freshworks. **It does: every link is clean, but every image is Freshdesk's.**
This file records what was measured, what has to land before the Freshdesk
account is closed, and in what order, because several of the items only work
one way round: an image copied after the account is gone cannot be copied, and
a domain pointed here before the legacy redirects work sends every old link to
a 404.

It covers the knowledge base and what sends a reader from it, or about it, into
Freshworks. The Meta side of the cutover — Freshchat is still Messenger's
primary receiver — is §5.1 of `docs/PROJECT-STATE.md` and is not repeated here;
it is one line in the checklist.

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
Freshdesk: `/` is `302 → /support/home`.

**A clean `normalise_kb_formatting` run is not evidence that no Freshdesk link
remains.** `rewriteLegacyArticleLinks` (`lib/kb/format.ts`) recognises one
shape, `…/solutions/articles/<id>`, and leaves an id it cannot resolve as it
was. Only a SELECT on the host answers the question.

## What production held

### Blocking: every image in the knowledge base is Freshdesk's

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
  public, in a public folder, with no role floor. The four `agents_only`
  handbook articles hold no image.
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

**The phone's quick replies.** 30 outbound WhatsApp messages in 26
conversations, 2026-10-07 to 2026-11-05 — **5 of them in the last 7 days** —
send customers the Freshdesk copy of articles this help centre already serves.
All are echoes typed in the WhatsApp Business app on the coexistence number
("Nayera Mohamed" in `/admin/channels`): outbound, no author, `meta.echo`
true. Nothing the console sends carries one. Every id has an equivalent here:

| Freshdesk id | Sent | Last sent  | Same article here                                                                                                                     |
| ------------ | ---: | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 154000228261 |    6 | 2026-10-31 | `ar/شحن-محفظتك-بشيب-بلو`, `en/charge-shipblu-wallet`                                                                                  |
| 154000190910 |    5 | 2026-11-04 | `ar/كيفية-إنشاء-أوردر-إرجاع-فردي`, `en/how-to-create-a-single-return-order`                                                           |
| 154000196089 |    4 | 2026-11-05 | `ar/كيفية-تسجيل-حساب-بنكي-أو-محفظة-إلكترونية-لتحويل-التحصيلات-الإسبوعية`, `en/how-to-register-a-payout-method-for-my-weekly-transfer` |
| 154000207426 |    4 | 2026-10-22 | `ar/كيفية-إنشاء-اوردر-استبدال-فردي`, `en/how-to-create-a-single-exchange-request`                                                     |
| 154000190907 |    4 | 2026-10-22 | `ar/كيفية-إنشاء-أوردر-توصيل-فردي`, `en/how-to-create-a-single-delivery-order`                                                         |
| 154000245150 |    2 | 2026-11-02 | `ar/التجزئة`, `en/try-buy`                                                                                                            |
| 154000216183 |    2 | 2026-10-31 | `ar/السحب-الفوري`, `en/instant-payout`                                                                                                |
| 154000217447 |    2 | 2026-11-02 | `ar/شوبيفاي`, `en/shopify`                                                                                                            |
| 154000207438 |    1 | 2026-10-14 | `ar/تحميل-طلبات-متعددة-توصيل،-إرجاع،-إستبدال،-تحصيل-نقدي`, `en/upload-multiple-orders-delivery-return-exchange-cash-collection`       |

All nine were sent with Arabic links. A link here is `/<locale>/a/<slug>` on
whichever host the help centre is served from.

**The merchant dashboard, app.shipblu.com** (release v3.43.2). 16 in-product
help links open the Freshdesk copy of 8 articles, plus 2 copies of a link to an
older Freshdesk account (`shipblu.freshdesk.com/a/solutions/articles/80001070415`,
which 404s). The newer merchant app on `merchant-web-production.onrender.com`
is clean.

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

The dashboard also loads the **Freshchat widget** (`fw-cdn.com/11720815/…`) for
every signed-in merchant, with no flag in front of it. That matters to the
knowledge base because **15 public articles** (8 Arabic, 7 English — among them
`en/claims-procedure`, `en/reaching-client-support-team` and
`ar/التواصل-مع-الدعم-الفني`) tell merchants to use live chat in their ShipBlu
account. Until the dashboard embeds this app's widget
(`docs/embedding-the-widget.md`), that instruction sends them to Freshchat.

**One click from an article.** 10 article links lead to pages whose "Support"
link is `https://support.shipblu.com/`: 4 to shipblu.com (3 such links per
page), 2 to go.shipblu.com (2 in its script bundle), and 4 to the myBlu App
Store listing (its support URL). The Google Play listing, the Shopify app
listing, docs.shipblu.com and the Zoho links are clean.

**The parallel copy.** `support.shipblu.com` still publishes the whole
knowledge base from Freshdesk: all 58 legacy article ids answer 200 there,
Freshdesk-hosted images included. It is what every link above lands on.

**The two addresses customers are given.** The help centre's only contact link
is `mailto:support@shipblu.com` (footer, home page, tracking page), and 15
articles give `help@shipblu.com`. §6.41 of `docs/PROJECT-STATE.md` records that
only `help-support@shipblu.com` is forwarded into this app; where these two
deliver is set in Zoho and could not be read. The domain's SPF still includes
`email.freshdesk.com`. Treat both as "probably Freshdesk" until somebody reads
the routing.

**Wording.** `en/file-a-claim` and `ar/الشحنات-التالفة` send readers to "our
Support Portal" / "بوابة الدعم", unlinked. The only portal customers know by
that name is `support.shipblu.com`.

### Configuration

- **`KB_PUBLIC_HOST` on the web service no longer names `support.shipblu.com`.**
  The widget script, the sitemap's 114 `<loc>`, `robots.txt`, every canonical,
  hreflang and JSON-LD URL are on `shipblu-support.onrender.com`, and the
  console is still served there, so the variable is unset or names the Render
  host. Read from output, not from the dashboard. `docs/PROJECT-STATE.md` §5.1
  said otherwise until this change.
- **The worker's value is unverified,** and it builds the CSAT survey links
  (`lib/csat/index.ts`) and the portal emails (`lib/portal/emails.ts`). The only
  survey ever created, on 2026-08-31, carried a `support.shipblu.com` link. It
  is dormant: CSAT is switched off, `csat_surveys` holds that one row and
  `contact_tokens` none. The admin CSAT page reads the web service's value, so
  it would not show the worker's.
- Two links built by this app on `support.shipblu.com` were delivered in August
  (one agent reply, one CSAT invitation) and 404 there. Nothing to do; nothing
  like them has been sent since 2026-08-31.

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

The 29 portal links in 18 version rows are still there, as they should be
until PR 2: Restore points them here once it is deployed.

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
  `dev` answered 404 for every one. On the deployed build this is still to be
  checked; the checklist item below does that.
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
  No other redirect moves.

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

Real Storage and the deployed console are still to see once.

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

### 6. Retire the Freshdesk importer — after the disconnection

`import_freshdesk_kb`, its handler and test, `lib/freshdesk/`, the
`/admin/import` card that starts it, and `FRESHDESK_DOMAIN` /
`FRESHDESK_API_KEY` from `lib/env.ts`, `render.yaml` and `.env.example`, all in
one commit (CI's `env-parity`, `job-registry` and `db-jobs` rules hold them
together). Keep `kb_redirects`, `app/help/legacy`, `freshdeskArticleId` and
the `source_system` values: they serve inbound links for as long as anybody
holds one.

### 7. Freshdesk's portal pages land on their counterparts

Added after the domain moved, and it lands before PR 6, not after it.

PR 3 answers the URLs that name an article or a folder. Everything else of
Freshdesk's portal still answered as nothing here: on `support.shipblu.com`,
with `KB_PUBLIC_HOST` unset, `/support/home`, `/support/tickets/new`,
`/support/login` and `/support/solutions` answered the console's
`307 /login?next=…`, and `/ar/support/home`, `/en/support/home` and
`/ar/support/solutions` the help centre's 404 (measured 2026-11-11 and 12).
With the variable set, the help-centre host's catch-all would have made every
one a 404. These are the paths customers' bookmarks hold, since Freshdesk's own
`/` went to `/support/home` and on to `/ar/support/home`.

What arrived, from Render's request log for `support.shipblu.com` between
2026-11-11 21:04 and 2026-11-12 09:15 UTC, with our own curl checks left out:
the portal home 22 times (phones in Egypt among them), Freshdesk's category
pages 8, the knowledge-base index 6, its search 6 (one person, in Arabic), the
ticket form 5 (Googlebot among them), the sign-in and sign-up 4, and one ticket
page from a Freshdesk notification email, opened on an iPhone.

**Built.** `proxy.ts` answers them itself, after the legacy block and ahead of
the help-centre host, the locale rewrite and the sign-in check, on every host.
`lib/kb/freshdesk-portal.ts` decides where each goes and carries the reasons.
None of those needs a lookup, so none goes through `/help/legacy`. A category
does, and since its own pull request it goes there with the articles and the
folders (below). The language is the path's own when the help centre has it,
and Arabic otherwise:

| Freshdesk                                            | Here                                    |
| ---------------------------------------------------- | --------------------------------------- |
| `[/<l>]/support`, `/support/home`                    | `/<l>`                                  |
| `[/<l>]/support/solutions`                           | `/<l>`                                  |
| `[/<l>]/support/solutions/<category id>[-<title>]`   | `/<l>/c/<slug>`, by lookup              |
| `[/<l>]/support/solutions/folders/<id>[/page/<n>]`   | `/<l>/c/<category>/<folder>`, by lookup |
| `[/<l>]/support/tickets/new`, `/tickets[/…]`         | `/<l>#contact`, standing in             |
| `[/<l>]/support/login`, `/signup`                    | `/<l>#contact`, standing in             |
| `[/<l>]/support/search[/solutions]?term=…`           | `/<l>/search?q=…`                       |
| anything else under `/support` (`solutions.json`, …) | as before                               |

"As before" is the help centre's 404 for a locale path. For a bare one, it
is the console's sign-in until `KB_PUBLIC_HOST` names `support.shipblu.com`,
which production does not yet, and the help centre's 404 from then on.

- **All 302**, but for the category, which the legacy route now answers
  (below). The home and the index name the page they land on, so the legacy
  route's rule would make them 301. A browser keeps a 301 with no expiry,
  though, and these are the paths Freshdesk's own `/` redirects through, so a
  DNS rollback while Freshdesk is live would send every browser that had loaded
  the home here to `/ar` on Freshdesk. A 302 costs little meanwhile: `/ar` is
  already the canonical page and in the sitemap. They become 301 after the
  disconnection (the checklist). The others stand in for pages this help centre
  does not have yet, and stay 302 so the stand-in is not kept once it does.
  Never 307 or 308, which would re-send a stale Freshdesk sign-in form's
  password to the page it was redirected to.
- **The ticket pages, the sign-in and the sign-up go to the contact band, not
  the portal.** `/forms` is a sign-in wall in production, which has no ticket
  form (0 rows on 2026-11-12). Freshdesk's requester accounts were not
  migrated: every portal identity with a password was made here after the move (four on 2026-11-12, one verified). Its tickets were not
  imported either, and its numbers are not ours: our own `#44105` is a
  different ticket from the Freshdesk one a customer followed. The band offers
  the chat, the address, the form card and a Sign in card, none of them behind
  an account. Once a public form exists, the ticket form's rule becomes
  `/forms`. Once the portal opens, the sign-in's and the tickets' become the
  portal's.
- `proxy.test.ts` checks every shape on the help-centre host and on the Render
  host with `KB_PUBLIC_HOST` set and unset. It also checks that the answer is a
  302 for any method, that a session cookie changes nothing, that the search
  carries its term and nothing else, that articles and folders still reach the
  legacy route, and that the leftovers answer as they did. Seven of its cases
  fail against `proxy.ts` as it was.
- A production build served locally answered each shape, a category then
  among them, with a 302 and a relative `Location` on both hosts, with the
  variable set and unset:
  `/ar#contact` with its fragment, `/ar/search?q=` with the term encoded.
- **The redirect is absolute in the proxy.** Next parses a proxy's `Location`
  with no base, so the relative one `lib/http/redirect.ts` builds would throw
  there (`ERR_INVALID_URL`, a 500). Next relativises a same-host absolute one
  itself, as the measurement shows.
- **A category goes to its own page, through the legacy route** (its own pull
  request, after this one). The importer kept Freshdesk's category ids
  (`kb_categories.external_id`, `<id>:<locale>`), so the page is a lookup:
  `proxy.ts` hands `[/<l>]/support/solutions/<id>[-<title>]` to `/help/legacy`
  (`LEGACY_CATEGORY`, the pattern `freshdeskCategoryId` reads the id with:
  no article's, folder's or help-centre path matches it, and its anchors keep
  out a Freshdesk tail behind another prefix and `/<id>/page/2`), and
  `resolveLegacyPath` finds the page (`resolveCategory`). The rule left
  `lib/kb/freshdesk-portal.ts`. What production's rows, read on 2026-11-12,
  make each answer once it is deployed:

  | Freshdesk                                  | Here                          |
  | ------------------------------------------ | ----------------------------- |
  | `[/ar]/support/solutions/154000297679[-…]` | `301 /ar/c/شركاء-شيب-بلو`     |
  | `/en/support/solutions/154000297679[-…]`   | `301 /en/c/shipblu-partners`  |
  | `[/ar]/support/solutions/154000297680[-…]` | `301 /ar/c/عملاء-شيب-بلو`     |
  | `/en/support/solutions/154000297680[-…]`   | `301 /en/c/shipblu-customers` |
  | `[/<l>]/support/solutions/154000297102`    | 404 (the employee guide)      |
  | any other id                               | 404                           |
  - The translation is chosen as an article's is: the path's language, then
    Arabic, then whichever translation answers.
  - Only a category some reader can open answers. A category has no visibility
    of its own, and its page is a 404 for anybody who can read none of its
    articles in its language (`getCategory`). So a translation answers when it
    holds an article in its own language that `someReaderMayOpen` passes:
    published, and neither it nor its folder agents-only.
  - The answer is 301 when it is the translation the URL names, and 302 while
    another stands in for one closed for now (`LegacyAnswer`). A 301 here
    carries the risk the home's and the index's would. On a DNS rollback, a
    browser that kept one would ask Freshdesk for `/ar/c/…`, which it does not
    have. Every article URL has carried that same risk since PR 3, though, and
    a category URL is not one of the paths Freshdesk's own `/` redirects
    through, which is what made the home's 301 a loop or a dead end.
  - **The employee guide answers 404.** This section once asked for the home
    instead. Four things decide it:
    - It is what the route already answers for production's four internal
      articles (PR 3).
    - It is what the guide's own page answers: `/ar/c/دليل-الموظف` is a 404
      for every reader.
    - It answers exactly as an id nothing was imported as does. A redirect
      home for this id alone would confirm that an internal category exists
      under it.
    - The home holds nothing of the guide, so sending readers there is a soft
      404: a search engine treats it as one, and a reader looks for something
      that is not there. The guide's readers are agents, whose copy is in the
      console's knowledge base, which a public route must not point at.

    An id nothing was imported as answers 404 too, where this section's
    stand-in sent it home. That is the legacy route's rule for an unknown URL.
    Every category URL Render's log holds from the move to 16:30 UTC on
    2026-11-12, our own curl checks left out, named one of the two public
    categories: 8 requests, under `/ar` or `/en`, four from browsers on Windows
    and a Mac and four from two crawlers.

  - `lib/kb/legacy-resolve.db.test.ts` builds production's three categories and
    checks every answer for them against `getCategory`, so none is a page that
    404s. It also checks a translation closed either way, the order of the
    translations, the guide, and a category whose only readable articles are
    in the other language. `app/help/legacy/route.db.test.ts` checks the
    encoded Arabic `Location`. `proxy.test.ts` checks the rewrite on both
    hosts, with the variable set and unset, and that each path it sends is one
    `freshdeskCategoryId` reads an id from.
  - A slug is now put in a `Location` a code point at a time
    (`lib/http/redirect.ts`). `slugify` keeps an emoji, which is two UTF-16
    units, and matched a unit at a time it threw `URI malformed`, so a
    category or an article named with one answered its old URL with a 500.
    None in production is.

- **A folder goes to its own page, through the legacy route** (its own pull
  request, after the category's). Until it, `resolveLegacyPath` read no
  visibility for a folder and answered every imported one with a 301 to the
  home, the employee guide's four agents-only folders included. So the
  response confirmed that an internal folder existed under the id, and the
  301 pinned the home in browsers and search indexes where the folder's own
  page could answer. The importer kept the folders' ids as it kept the
  categories' (`kb_folders.external_id`, `<id>:<locale>`), so the page,
  `/<l>/c/<category>/<folder>`, is a lookup (`resolveFolder`), and each
  translation is read with the category it is in now: a folder moved since
  the import answers at the page it has there. `proxy.ts` hands the shape to
  `/help/legacy` as it always has (`LEGACY_FOLDER`), now through the pattern
  `freshdeskFolderId` reads the id with (`FRESHDESK_FOLDER`), unanchored as
  it always was. What production's rows, read on 2026-11-12, make each answer
  once it is deployed:

  | Freshdesk                                      | Here                                                |
  | ---------------------------------------------- | --------------------------------------------------- |
  | `[/ar]/support/solutions/folders/154000746959` | `301 /ar/c/شركاء-شيب-بلو/الأسئلة-الشائعة`           |
  | `/en/support/solutions/folders/154000746959`   | `301 /en/c/shipblu-partners/faqs`                   |
  | `/en/support/solutions/folders/154000746964`   | `301 /en/c/shipblu-customers/myblu-support`         |
  | each of the 8 public ids, with any prefix      | `301` to its page, in the path's language or Arabic |
  | any of them with `/page/<n>` after the id      | the same as without it                              |
  | the guide's `154000745060`–`154000745063`      | 404                                                 |
  | any other id                                   | 404                                                 |
  - The translation is chosen as a category's is, by the same function
    (`translationAnswer`): the path's language, then Arabic, then whichever
    translation answers.
  - Only a folder some reader can open answers: not agents-only, and holding
    an article in its category's language that `someReaderMayOpen` passes,
    which is what `getFolder` lists. `getFolder` does open a folder that
    lists nothing, with a line saying it is empty. A 301 there would be a
    soft 404 the browser keeps, so such a folder answers 404, as a category
    with nothing to list does.
  - The answer is 301 when it is the translation the URL names, and 302 while
    another stands in for one closed for now (`LegacyAnswer`).
  - **The guide's four folders answer 404**, with the same status, headers and
    body as an id nothing was imported under, for the reasons the guide itself
    does (above). In the log, only our own checks asked for any of them.
  - **A page of a folder's list answers as the folder.** Freshdesk listed a
    folder's articles over pages, `/folders/<id>/page/2`, and `LEGACY_FOLDER`
    has always matched them. The help centre's folder page lists every article
    at once (`getFolder` takes no limit), so whatever a page of Freshdesk's
    listed is on it. A 404 would turn away a reader whose answer is one page
    away, and a page here per page there would be the same list cut short.
    It is a 301 like the folder's own, because the folder's page is where
    those articles stay. The log's pages are of `154000746959`, production's
    largest folder at 15 articles, and every `/page/` URL in the log since the
    move is one of them. A category's `/<id>/page/2` stays out, by its
    pattern's end anchor.
  - Render's log for `support.shipblu.com`, from the move to 16:50 UTC on
    2026-11-12, our own curl checks left out, holds 37 folder URLs answered
    with the home's 301:
    - 4 from browsers on Windows and a Mac, 1 fetched for a ChatGPT user, 2
      from headless browsers, and 30 from crawlers (Petal, Semrush, Baidu,
      Yandex, Exa and a vendor's);
    - every one of the 8 public ids, under `/ar` and `/en`, and once with no
      language (`/solutions/folders/<id>`);
    - 5 of them a page of a list, `/page/1` or `/page/2`, and 9 more pages
      with a trailing slash, which Next's own 308 answered first.

    Two more, for ids nothing was imported under, answered 404, as they still
    will.

  - `lib/kb/legacy-resolve.db.test.ts` builds production's categories, three
    of its public folders (two sharing an Arabic slug under different
    categories) and the guide's four. It checks every answer against
    `getFolder`, so none lands on a page that 404s or lists nothing. It also
    covers:
    - every prefix, a language with a region, one the help centre lacks;
    - pages of a list, with and without a trailing slash;
    - a translation closed three ways (articles archived, the folder
      agents-only, only articles in the other language);
    - the order of the translations, and the guide;
    - a folder of drafts, of agents-only articles, of the other language's
      articles, or of nothing, one in a language the help centre lacks, and a
      native folder carrying the id;
    - a `logged_in` folder, a folder moved to another category, and a
      `kb_redirects` row for the URL.

    `app/help/legacy/route.db.test.ts` checks the encoded Arabic `Location`
    and that an agents-only folder's 404 is an unknown id's, status, headers
    and body. `proxy.test.ts` checks the rewrite on both hosts, with the
    variable set and unset, and that each path it sends is one
    `freshdeskFolderId` reads an id from. 14 of the new cases fail against
    the resolver as it was.

## To-dos outside this repository

| Owner                                | To do                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Support lead                         | Replace the nine Freshdesk links in the Business app's quick replies on the coexistence number with the links above, and ask the team to stop pasting `support.shipblu.com/…/solutions/…` links.                               |
| Support lead (console)               | Reword the live-chat instruction in the 15 articles if the dashboard's chat is not replaced first, and "Support Portal" in `en/file-a-claim` and `ar/الشحنات-التالفة`.                                                         |
| Merchant dashboard (app.shipblu.com) | Point the 16 help links at this help centre (table above) and replace the Freshchat loader with this app's widget, per `docs/embedding-the-widget.md`. `app.shipblu.com` is already in the widget's `frame-ancestors`.         |
| Marketing site and go.shipblu.com    | Point "Support" somewhere that is not Freshdesk, or leave it on `support.shipblu.com` and let the domain move fix it.                                                                                                          |
| App Store Connect                    | The myBlu listing's support URL, as above.                                                                                                                                                                                     |
| Mail admin (Zoho)                    | Say where `support@shipblu.com` and `help@shipblu.com` deliver. If it is Freshdesk, forward them here or change the address the help centre gives. Remove `include:email.freshdesk.com` from SPF once Freshdesk sends nothing. |
| DNS                                  | The `support.shipblu.com` move, in the checklist's order.                                                                                                                                                                      |
| Freshdesk admin                      | Point its portal URL back at its own `*.freshdesk.com` address while the team still answers there: its notification emails link `support.shipblu.com/support/tickets/<n>`, which lands here now (PR 7).                        |

## Checklist before Freshdesk is disconnected

Order matters. The check beside each item is what proves it, not the merge.

**Before anything is switched off**

- [ ] **The last import, if any, runs first.** If the cutover re-run in
      `plans/kb-article-stats.md` is still wanted, run `import_freshdesk_kb`
      now. Once PR 2 is deployed, the import points pictures and links here
      itself. Before it, follow it with `normalise_kb_formatting` to rewrite
      the 29 links again. After this, nothing imports: unset
      `FRESHDESK_DOMAIN` and `FRESHDESK_API_KEY` on the worker. _Check:_ the
      audit query's `links, live` row answers 0.
- [x] **PR 1 is deployed and its job has run** — `dryRun=true`, then for
      real, then `dryRun=true` again reporting nothing to do. _Check:_ the
      audit query's two `images` rows answer 0; every `kb_images` row loads
      through its route. Done 2026-11-08: deployed at 21:05 UTC (#497), run
      at 21:13. On 2026-11-09 both `images` rows read 0, and all 207 rows
      answered their route with an image.
- [ ] **PR 2 is deployed.** _Check:_ its tests restore a version carrying a
      Freshdesk link and save one carrying a Freshdesk `href` and `src`, and
      neither reaches `kb_articles` (staging holds no knowledge base to try it
      on).
- [ ] **The phone stops sending Freshdesk links.** _Check:_ the audit query's
      `phone/app sends, 7 days` row answers 0.
- [ ] **The dashboard** links here and loads this widget, not Freshchat.
      _Check:_ no Freshworks host in app.shipblu.com's script chunks.
- [ ] **The marketing site, go.shipblu.com and the App Store listing** are
      updated, or deliberately left for the domain move.
- [ ] **Mail:** both addresses customers are given reach this app.
      _Check:_ a test mail to each opens a ticket here.
- [ ] **The article wording** is updated (live chat, Support Portal).
- [ ] **Messenger's swap** per §5.1 of `docs/PROJECT-STATE.md` — Freshchat is
      still its primary receiver, so disconnecting Freshworks without it
      leaves Messenger unanswered.

**Moving `support.shipblu.com`, if the name is kept**

- [ ] **PR 3 is deployed.** _Check:_ the six legacy shapes 301 on the Render
      host.
- [ ] **Lower the CNAME's TTL** (14400 today) at least a TTL ahead.
- [ ] **Add `support.shipblu.com` as a custom domain** on the
      `shipblu-support` web service, then switch the CNAME and wait for the
      certificate.
- [ ] **Only then** set `KB_PUBLIC_HOST=support.shipblu.com` — a bare
      hostname, because `proxy.ts` compares it with `Host` as written — on the
      web service **and** the worker, which builds the survey and portal-email
      links, and redeploy both. Set before the DNS answers here, it repeats
      August: every published URL on a host that serves Freshdesk.
- [ ] _Check:_ `/widget/embed.js`'s `BASE`, the sitemap and the canonicals name
      `support.shipblu.com`; `/en/a/packaging-guidelines` answers 200 there; a
      Freshdesk URL from the tables above 301s to its article; `/inbox` there
      is the help centre's 404, not the console.

**After the disconnection**

- [ ] Re-run [the audit](#re-running-this-audit) and get zeros where it says.
- [ ] Every `kb_images` row's route still answers an image — proof the copies,
      not Freshdesk's bucket, are what the pages load.
- [ ] PR 6. Remove Freshdesk from SPF.
- [ ] Make the portal's home and index rules 301 (PR 7,
      `lib/kb/freshdesk-portal.ts`), now that the name cannot go back to
      Freshdesk. Not the stand-ins, which stay 302.
- [ ] `docs/PROJECT-STATE.md` §1 and §5.1 say Freshdesk is gone, with the date.

## Re-running this audit

One call answers the headline numbers. On 2026-11-07 it returned images 214
in 61 rows in both tables, links 0 live and 29 in 18 version rows, and 5
Freshdesk links sent from the phone in the last 7 days (30 in all).

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
where m[1] ~* '(fresh(desk|works|chat|service)|myfreshworks|fwcdn|fw-cdn|support\.shipblu\.com|/solutions/(articles|folders)/|/support/(home|tickets|solutions))'
union all
select 'links, versions', count(*), count(distinct v.id)
from kb_article_versions v, regexp_matches(v.body_html, 'href="([^"]*)"', 'gi') m
where m[1] ~* '(fresh(desk|works|chat|service)|myfreshworks|fwcdn|fw-cdn|support\.shipblu\.com|/solutions/(articles|folders)/|/support/(home|tickets|solutions))'
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

After the domain move, `support.shipblu.com` is ours, and a link of the app's
own shape there (`/<locale>/a/<slug>`) is fine; the link queries above would
then need `support\.shipblu\.com` narrowed to Freshdesk's path shapes.

From a shell:

```bash
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://support.shipblu.com/
```

Until the move on 2026-11-11, `302 https://support.shipblu.com/support/home` —
Freshdesk. Since then, `307 https://support.shipblu.com/ar` (2026-11-12): this
app's front door. `/support/home` answers `302` to `/ar` once PR 7 is deployed,
and `/support/solutions/154000297679` answers `301` to `/ar/c/` and the
category's slug once its category rule is. `/support/solutions/folders/154000746959`
answers `301` to `/ar` today, and to `/ar/c/` and the category's and folder's
slugs once the folder rule is; `/support/solutions/folders/154000745060`, the
employee guide's, answers `301` to `/ar` today and `404` then.

```bash
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://shipblu-support.onrender.com/support/solutions/articles/154000189336
```

On 2026-11-07 `404`; `301` to the article once PR 3 is deployed.

```bash
curl -sS https://shipblu-support.onrender.com/widget/embed.js | grep -o 'var BASE = "[^"]*"'
```

Today `https://shipblu-support.onrender.com`; the custom domain once it has
moved.
