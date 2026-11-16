# The console on desk.shipblu.com, and the Render address retired

> should i change the app_url in the env? i think that makes sense since
> technically support.shipblu.com is now the service's official url, although
> the render url will always remain accessible

> shouldn't we change this properly? the render address needs to be phased out
> anyway

That is the request, on 2026-11-15, the day an admin signed in on the help
centre's host and found every group view in the inbox answering 404
(`docs/PROJECT-STATE.md` §6.119). The console's host was chosen the same day:
**desk.shipblu.com**.

## The decision

Three hosts become two:

| Host                           | Serves                                                                                         | Named by         |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------- |
| `support.shipblu.com`          | The help centre, the chat widget, survey and portal links. Never the console.                  | `KB_PUBLIC_HOST` |
| `desk.shipblu.com`             | The console, the webhooks, invite and alert links. The help centre's locale paths too, as now. | `APP_URL`        |
| `shipblu-support.onrender.com` | Everything, until it is switched off at the end of this plan.                                  | nothing          |

**`APP_URL` does not become support.shipblu.com.** Every link built on it is a
console page: an agent's invite (`/invite/<token>`), a low-rating alert
(`/inbox/<n>`), Meta's return from "Connect Instagram"
(`/api/meta/unified-login/callback`, which reads the agent's session) and the
help centre's sign-in sending an agent onwards (`consoleBaseUrl`). The proxy
serves support.shipblu.com as the help centre alone, so each would be the
help centre's 404.

**Not one host for both, either.** Serving the console on support.shipblu.com
means undoing the proxy's help-centre-only rule, and that rule is what sends a
customer following a stale link to the help centre's 404 rather than to a
staff sign-in page. It also puts the console's URLs on the public domain.
A subdomain of its own costs one DNS record.

**Same site, as any shipblu.com host is.** desk.shipblu.com and
support.shipblu.com share a registrable domain, so the session cookie's
`SameSite=Lax` does not keep it off a POST from one to the other. Next's
`Origin` check refuses a server action from another origin, and that check is
what stands between the two. `proxy.ts`'s header says so, and it was written
for this move. Nothing changes there.

## What depends on the Render address

Read on 2026-11-15 from Render's request logs, the repository and Sentry.
Nothing was written.

- **Agents.** They work on `shipblu-support.onrender.com`, and their sessions
  live there: the cookie is host-only, so each signs in once on the new host.
- **`APP_URL` names it.** Invite links are followed on it: two invites on
  2026-11-12 and one opened today. An invite lasts seven days
  (`INVITE_TTL_MS`), so one sent the day before the switch still names the
  old host for a week after it.
- **Every webhook.** WhatsApp, Meta (Page and Instagram) and Postmark's inbound
  email all post to it. None has posted to support.shipblu.com since the
  domain moved here on 2026-11-11. Each provider's URL is set in its own
  dashboard, and `lib/meta/subscriptions.ts` echoes back whatever callback Meta
  holds rather than rebuilding it from `APP_URL`, so nothing here moves them.
- **The widget's script tag.** Host pages still load
  `https://shipblu-support.onrender.com/widget/embed.js`, many times a minute.
  The script frames the origin it was loaded from (`BASE` in
  `app/widget/embed.js/route.ts`; `publicBaseUrl()` is only its fallback), so
  the chat window, and each visitor's token in that window's storage, live on
  the Render host too. Moving the tag moves the window to another origin, and
  every visitor starts afresh there: the widget no longer shows their earlier
  chat, and the next message from somebody mid-conversation opens a new ticket.
  Nothing is lost to the team, since every conversation stays in the console,
  and a signed identity links a visitor to their shipping account again but
  not to the old transcript (`lib/widget/identity.ts`).
  `docs/embedding-the-widget.md` already warns that a move does this. The
  sites are the ones `WIDGET_ALLOWED_ORIGINS` names, whose owners are not this
  repository. The first version of this plan said the window already lived on
  support.shipblu.com. It does not.
- **The myBlu API contract** lists `https://shipblu-support.onrender.com/api/v1`
  as a second production server (`lib/api/openapi.ts`). No route behind it is
  live yet.
- **Not affected:** Render's health check (a path), staging
  (`shipblu-support-staging.onrender.com`, its own service), the four crons and
  the worker (no host). No Sentry uptime monitor names the host.

## What the code does about it

On the branch with this plan:

- **The help centre's sign-in sends an agent to the console's host**
  (`consoleBaseUrl`), and starts no session on a host that serves no console.
  It is §6.119's fix, and what makes `APP_URL` the address agents land on.
- **`/` on the console's host opens the inbox** (`isConsoleHost`, in the
  proxy). Everywhere else `/` is the help centre's front door
  (`app/page.tsx`), which would have greeted an agent typing desk.shipblu.com
  with the Arabic help centre. Only while `KB_PUBLIC_HOST` is set, so
  development and staging keep the front door they have. Today `APP_URL` names
  the Render host, so the redirect applies there as soon as this deploys.

Nothing else in the code names a host. Each step below is configuration.

## The cutover

In order. Each step says who makes it, how it is checked and what undoes it.
Nothing is removed from the old host until the last step, so every step before
it can be undone by putting one value back.

1. **DNS (you). Done 2026-11-16.** A `CNAME` for `desk.shipblu.com` to
   `shipblu-support.onrender.com`, in the shipblu.com zone on Google Cloud DNS,
   as support.shipblu.com's is. On 2026-11-15 the name did not exist
   (NXDOMAIN); on 2026-11-16 it resolved to the Render host. _Undo: delete the
   record._
2. **Render (you, dashboard). Done 2026-11-16.** The web service's Settings →
   Custom Domains lists `desk.shipblu.com` beside `support.shipblu.com`, both
   Verified with a certificate issued, and `render.yaml`'s `domains:` names
   both. _Checked from outside:_ the certificate validates,
   `https://desk.shipblu.com/api/health` answers `ok`, `/login` answers 200 and
   `/inbox` sends a signed-out visitor to `/login?next=%2Finbox`. `/` still
   answered the help centre's `/ar`, since the inbox redirect had not deployed.
   _Undo: remove the domain._
3. **Meta (you, App Dashboard), before `APP_URL` moves.** Each of these names
   the console's origin, which `APP_URL` is about to change. Add the new value
   beside the old one in each, and keep the Render entries until step 9:
   - Instagram → API setup with Instagram login → the Unified Login tab's
     **Redirect URL**: register
     `https://desk.shipblu.com/api/meta/unified-login/callback`
     (`plans/instagram-unified-login.md`, step 2). It must match character for
     character what `unifiedLoginReadiness` builds from `APP_URL`.
   - Facebook Login for Business → Settings → **Valid OAuth Redirect URIs**:
     the same URL, and the console's origin, `https://desk.shipblu.com/`, which
     `plans/whatsapp-coexistence.md` lists there for Embedded Signup.
   - The same page's **Allowed Domains for the JavaScript SDK**:
     `desk.shipblu.com`, which Embedded Signup's window opens from
     (`plans/whatsapp-coexistence.md`).

   Missed, "Connect Instagram" answers "URL blocked" and the Business-app
   number's window refuses to open. Both are admin actions, and nothing a
   customer reaches depends on them.

4. **`APP_URL` = `https://desk.shipblu.com`** in the
   `shipblu-support-production` env group (you, dashboard). Not on a service:
   Render's API, the one this session has, sets service variables only, and a
   service copy would shadow the group (`render.yaml` says the last one was
   deleted on 2026-09-26) and leave the worker on the old value. A group change
   redeploys all six services. Note the old value before changing it. _Check:_
   Render's events show the six redeploys, `/admin/agents` builds invite links
   on desk.shipblu.com, and once the code below has deployed, an agent signing
   in on support.shipblu.com's help centre lands on `desk.shipblu.com/login`.
   _Undo: put the Render URL back._ Not in the half hour before 00:00 UTC, when
   the nightly rollup and a redeploy could overlap.
5. **Agents (you).** Tell the team the address, desk.shipblu.com, and that
   each signs in once there. The old address keeps working until step 9.
6. **Webhooks (you, each provider's dashboard), one at a time.**
   - Meta app → Webhooks: the Page, Instagram and WhatsApp Business Account
     objects to `https://desk.shipblu.com/api/webhooks/meta` and
     `…/api/webhooks/whatsapp`, as each is now. The Instagram product's own
     webhook settings (Instagram Login) carry a URL of their own. The verify
     token stays `META_VERIFY_TOKEN`.
   - Postmark → the inbound stream's webhook to
     `https://desk.shipblu.com/api/webhooks/email/postmark`, with the same
     credentials it carries now. The same for any other webhook it posts.

   _Check, per provider:_ Render's request log shows its posts on
   desk.shipblu.com answered 200 and none on the old host since the change, and
   `webhook_events` keeps growing for it. _Undo: the old URL, which still
   answers._

7. **The widget's script tag (each host page's owner).**
   `<script src="https://support.shipblu.com/widget/embed.js" async>`, the
   customer-facing host (`docs/embedding-the-widget.md`). Every visitor's chat
   starts afresh with it (above), once, so make the change outside working
   hours, when the fewest conversations are open, and let the team know that
   the next morning's web chats may continue yesterday's under a new ticket.
   `WIDGET_ALLOWED_ORIGINS` needs no change: it names the pages that embed the
   widget, not the host serving it. _Check:_ `/widget/embed.js` requests on the
   old host fall away.
8. **The contract (a myBlu API change).** Drop the Render server from
   `lib/api/openapi.ts`'s `servers`, and refresh the SDK's pin. Its own pull
   request, under that plan's rules for changing the contract.
9. **Retire the Render address.** Once the old host's request log has held
   nothing but crawlers and stragglers for a week, and no invite older than
   step 4 is still open: `renderSubdomainPolicy: disabled` in `render.yaml` and
   on the dashboard, the Meta redirect URI and domain for the old host removed,
   and `docs/PROJECT-STATE.md` §2 updated. _Undo: enable the subdomain again;
   it is a switch, not a deletion._

## What this does not change

- **Staging** keeps `shipblu-support-staging.onrender.com`. It has no custom
  domain, it is suspended, and it is resumed only for named test windows.
- **What customers see**, but for the widget (step 7). The help centre, survey
  and portal links are on support.shipblu.com already (`publicBaseUrl()`).
- **The rule that support.shipblu.com serves no console.** Step 4 is what makes
  §6.119's sign-in send agents somewhere real, rather than to a Render address
  being switched off.
