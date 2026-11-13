import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { contactIdentities } from './customers';

/**
 * Why a session stopped before its day was up: the five reasons myBlu's backend
 * names on `POST /sessions/revoke` (`RevokeReason` in `lib/api/schemas.ts`), and
 * `ended`, the app's own `DELETE /session` — the SDK's `reset()` on one device,
 * which ends that device's session and nothing else. Kept apart from the
 * backend's `signed_out`, which is "sign out everywhere": the two read alike
 * and say different things about who asked.
 *
 * Text rather than an enum, so a reason the API gains later is a line of
 * TypeScript and not an `ALTER TYPE … ADD VALUE`, which a migration's own
 * transaction cannot then use.
 */
export type ApiSessionEndReason =
  'signed_out' | 'phone_changed' | 'account_deleted' | 'number_released' | 'other' | 'ended';

/**
 * Sessions for the myBlu app's ticket API (`plans/myblu-ticket-api.md`, _The
 * session_), one row per mint by myBlu's backend.
 *
 * A table of its own rather than `contact_sessions` with a discriminator, for
 * the reason that table gives for keeping agents and customers apart: one
 * missed `where` clause would turn a portal cookie into an app's bearer, or the
 * other way round. `/api/v1` never reads a cookie, and the portal never reads
 * this.
 *
 * It holds what `sessions` and `contact_sessions` hold — a SHA-256 of an opaque
 * token, never the token — so a dump of it authenticates nobody, which is the
 * argument AGENTS.md asks for before a second table holds anything
 * credential-shaped.
 *
 * **No column is written on the request path.** The life is fixed at
 * twenty-four hours from minting, with no sliding expiry and no `last_used_at`:
 * the API is polled, behind an admission gate of eight (`db/client.ts`), and a
 * write per poll is what a fixed life buys back. A new token costs the app one
 * call to its own backend, which is also the moment that backend learns whether
 * the user is still signed in.
 *
 * **The contact is not here.** It is read through `identity_id` on every
 * request and never stored, so a contact merge — which re-points the identity
 * — moves a live session with it, and a block is the next request's answer.
 *
 * Revoking stamps a row and never deletes it. The nightly `cleanup` deletes a
 * row thirty days after `expires_at` (`deleteSweptApiSessions`); until then
 * these rows are the only record of who myBlu's backend vouched for, with which
 * phone, when — what a suspected leak of `MYBLU_API_TOKEN` is read back from.
 */
export const apiSessions = pgTable(
  'api_sessions',
  {
    /** SHA-256 of the whole token, `sbu_` included. The token is never stored. */
    tokenHash: text('token_hash').primaryKey(),

    /**
     * The `api` identity, `('api', 'myblu:<externalUserId>')`. Cascading: a
     * purged contact takes its identities, and their sessions go with them.
     */
    identityId: uuid('identity_id')
      .notNull()
      .references(() => contactIdentities.id, { onDelete: 'cascade' }),

    /**
     * The phone the backend vouched for at this mint, as digits without the
     * plus — the form every phone in production is in. `contact_identities`
     * has no column for a phone, and the `api` identity is keyed on the
     * account rather than the number, so this is where the number is kept.
     */
    phone: text('phone').notNull(),

    /**
     * The app the session was minted for — `ios` or `android`, and its version
     * — as the app told its backend and the backend passed on. Labels for an
     * agent to read, never a credential.
     */
    platform: text('platform').notNull(),
    appVersion: text('app_version').notNull(),

    /**
     * The minting request's `X-Forwarded-For` chain, its last hops as they
     * arrived (`forwardedChain` in `lib/http/rate-limit.ts`): myBlu's backend,
     * not the app. The whole chain rather than one address picked from it,
     * because the first hop is whatever the caller wrote — somebody minting
     * with a leaked `MYBLU_API_TOKEN` can write the backend's own address there
     * — and the hops the platform's proxies append come after it. Read for a
     * leak, the addresses at the end of the chain are the ones nobody chose.
     */
    forwardedFor: text('forwarded_for'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason').$type<ApiSessionEndReason>(),
  },
  (t) => [
    // Revoking every session of one account, and the cascade from a purge.
    index('api_sessions_identity_idx').on(t.identityId),
    // The nightly sweep.
    index('api_sessions_expires_idx').on(t.expiresAt),
  ],
);
