import { Badge, Card, buttonClass } from '@/components/ui';
import { env } from '@/lib/env';
import { instagramLoginConfigured, unifiedLoginConfigured } from '@/lib/meta/connection';
import { START_PATH, unifiedLoginReadiness } from '@/lib/meta/unified-login';

/**
 * The Instagram account's Unified Login connection, on the Channels page: what
 * it is sending over today, and the button that connects (or reconnects) it.
 *
 * A server component with no form, because the connect control is a plain
 * link to a route handler that answers with a redirect to facebook.com. A
 * `<Link>` would try a soft navigation first, fetch the redirect, fail on the
 * cross-origin hop and fall back to a hard one — opening the dialog twice,
 * with two state cookies, the first of which the callback would then refuse.
 *
 * Read on the server, where the variables are, like the WhatsApp connect
 * card: a connection whose variables are missing is still a card, naming them
 * and where they go.
 */
export function UnifiedLoginCard({ canConnect }: { canConnect: boolean }) {
  if (!canConnect) return null;

  const connected = unifiedLoginConfigured();
  const readiness = unifiedLoginReadiness();
  const accountId = env().INSTAGRAM_ACCOUNT_ID ?? null;

  return (
    <Card className="mb-4 flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Instagram — Unified Login</h2>
        {connected ? <Badge tone="success">Unified Login</Badge> : null}
      </div>

      {connected ? (
        <>
          <p className="text-(--color-text-secondary)">
            Instagram replies, profile reads and comment actions go out over graph.facebook.com with{' '}
            <code>INSTAGRAM_UNIFIED_LOGIN_TOKEN</code>
            {accountId ? (
              <>
                , as account <code>{accountId}</code>
              </>
            ) : null}
            .
          </p>
          {instagramLoginConfigured() ? (
            <p className="text-(--color-text-secondary)">
              <code>INSTAGRAM_ACCESS_TOKEN</code> is still set, so the direct Instagram connection
              is now second in line and sends nothing while this token is present.{' '}
              <code>plans/instagram-unified-login.md</code> says when to disconnect it — in the
              dashboard first, the variable last.
            </p>
          ) : null}
          {readiness.ready ? (
            <a href={START_PATH} className={`${buttonClass({ variant: 'secondary' })} self-start`}>
              Connect again
            </a>
          ) : (
            <NotReady missing={readiness.missing} again />
          )}
        </>
      ) : readiness.ready ? (
        <>
          <p className="text-(--color-text-secondary)">
            Meta&rsquo;s login opens for this app&rsquo;s Unified Login configuration. Sign in as an
            admin of ShipBlu&rsquo;s business portfolio, pick that portfolio and the Instagram
            account the team answers from, and Meta issues a system-user token that never expires.
            It is shown once, on the page you come back to, with the instruction to set it as{' '}
            <code>INSTAGRAM_UNIFIED_LOGIN_TOKEN</code> on Render; nothing is stored here.
          </p>
          <a href={START_PATH} className={`${buttonClass()} self-start`}>
            Connect Instagram
          </a>
        </>
      ) : (
        <NotReady missing={readiness.missing} />
      )}
    </Card>
  );
}

/**
 * The checklist of missing variables. Every one of them belongs in this
 * environment's own group, so the paragraph names the group once rather than
 * per variable — and a redeploy, not a reload, because `env()` reads the
 * environment once per process.
 */
function NotReady({
  missing,
  again = false,
}: {
  missing: { variable: string; why: string }[];
  again?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-(--color-text-secondary)">
        {again
          ? 'Connecting again needs these on Render, in this environment’s own group — '
          : 'This environment cannot open Meta’s login yet. Set these on Render in this environment’s own group — '}
        <code>shipblu-support-production</code> on production,
        <code> shipblu-support-staging</code> on staging — then deploy; this list updates once the
        new deploy is live.
      </p>
      <ul className="flex flex-col gap-1.5">
        {missing.map((setting) => (
          <li key={setting.variable} className="flex flex-wrap gap-x-2 text-xs">
            <code className="font-medium">{setting.variable}</code>
            <span className="text-(--color-text-secondary)">{setting.why}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
