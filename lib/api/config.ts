import { IANAZone } from 'luxon';
import type { z } from 'zod';
import { isWithinBusinessHours, nextOpeningAt, type HoursConfig } from '@/lib/hours';
import {
  MAX_WIDGET_FILES,
  MAX_WIDGET_FILE_BYTES,
  MAX_WIDGET_MESSAGE_CHARS,
  MAX_WIDGET_TOTAL_BYTES,
  WIDGET_CONTENT_TYPES,
  WIDGET_EXTENSIONS,
} from '@/lib/widget/files';
import { MAX_OPEN_TICKETS } from './limits';
import type { Config, SupportHours } from './schemas';
import type { Caller } from './sessions';

/**
 * What a screen polls at before its first answer's `pollAfterSeconds`: five
 * seconds on an open thread, thirty on the list (`plans/myblu-ticket-api.md`,
 * _Reading without a stream_). Each at least 1, as the contract requires of
 * every wait it answers.
 */
export const POLL_THREAD_SECONDS = 5;
export const POLL_LIST_SECONDS = 30;

/**
 * How far ahead `opensAt` looks: a year, as `addBusinessMinutes` scans, rather
 * than the fourteen days the widget's line asks for. With a timezone set,
 * `opensAt: null` while closed then means only "nothing opens within a year" —
 * a schedule with no open day — and never a closure of a few weeks read as
 * "hours not set", the one null the contract does not name. A real week
 * answers within seven days of scanning; only a week with no open day pays the
 * whole year, about 13 ms.
 */
const OPENS_AT_LOOKAHEAD_DAYS = 366;

/**
 * The team's hours as the app is told them (`SupportHours`), at one instant.
 *
 * Computed in the schedule's own zone, never the server's or the reporting
 * zone's, through `lib/hours`, so a holiday, Cairo's clock changes and a day
 * the schedule is shut are read the way the widget and the SLA clock read them.
 * `online` and `opensAt` are asked of one `now`, so the two cannot describe
 * different moments.
 *
 * No hours, or a zone luxon cannot read — which `isWithinBusinessHours` already
 * treats as closed, and which the admin form refuses, so it takes a row edited
 * by hand — is `{ online: false, opensAt: null, timezone: null }`: "working
 * now, by its own hours" is false when there are none, as the widget answers,
 * and a null `timezone` is how a client knows to draw no line at all, as the
 * help centre draws none.
 */
export function supportHoursAt(hours: HoursConfig | null, now: Date): z.input<typeof SupportHours> {
  if (!hours || !IANAZone.isValidZone(hours.timezone)) {
    return { online: false, opensAt: null, timezone: null };
  }
  const online = isWithinBusinessHours(hours, now);
  const opensAt = online ? null : nextOpeningAt(hours, now, OPENS_AT_LOOKAHEAD_DAYS);
  return { online, opensAt: opensAt?.toISOString() ?? null, timezone: hours.timezone };
}

/**
 * `GET /config`, built fresh from a named field list as every answer of this
 * API is, so nothing the session row or the contact holds can ride along.
 *
 * - `user.id` is the identity's id, which a contact merge does not change: a
 *   contact's id here would wipe an app's store whenever an agent merged a
 *   duplicate. `externalId` is the account the session was minted for, which
 *   the SDK compares with the user it asked for.
 * - `tickets.canCreate` is whether an `api` channel row is on (`apiChannel`):
 *   with none, `POST /tickets` answers `503 not_configured`, and the app hides
 *   its button rather than failing a send.
 * - `limits` are the widget's, because the files are judged by the widget's
 *   own functions, and they move with `proxyClientMaxBodySize`.
 * - `support`, the team's hours (`supportHoursAt`), present from stage 5: the
 *   hours of the oldest active `api` row's default group — its own schedule,
 *   else the default — and with no active row the default, so the app can
 *   still say when the team works while it offers no new ticket. Required
 *   here, so no answer from this build can leave it out; a server before
 *   stage 5 answers without it, which a client already handles.
 */
export function configFor(
  caller: Caller,
  canCreate: boolean,
  support: z.input<typeof SupportHours>,
): z.input<typeof Config> {
  return {
    user: { id: caller.identityId, externalId: caller.externalUserId },
    tickets: { canCreate, maxOpen: MAX_OPEN_TICKETS },
    limits: {
      messageMaxChars: MAX_WIDGET_MESSAGE_CHARS,
      maxFiles: MAX_WIDGET_FILES,
      maxFileBytes: MAX_WIDGET_FILE_BYTES,
      maxTotalBytes: MAX_WIDGET_TOTAL_BYTES,
      contentTypes: [...WIDGET_CONTENT_TYPES],
      extensions: [...WIDGET_EXTENSIONS],
    },
    support,
    polling: { threadSeconds: POLL_THREAD_SECONDS, listSeconds: POLL_LIST_SECONDS },
  };
}
