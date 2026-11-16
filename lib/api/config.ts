import type { z } from 'zod';
import {
  MAX_WIDGET_FILES,
  MAX_WIDGET_FILE_BYTES,
  MAX_WIDGET_MESSAGE_CHARS,
  MAX_WIDGET_TOTAL_BYTES,
  WIDGET_CONTENT_TYPES,
  WIDGET_EXTENSIONS,
} from '@/lib/widget/files';
import { MAX_OPEN_TICKETS } from './limits';
import type { Config } from './schemas';
import type { Caller } from './sessions';

/**
 * What a screen polls at before its first answer's `pollAfterSeconds`: five
 * seconds on an open thread, thirty on the list (`plans/myblu-ticket-api.md`,
 * _Reading without a stream_). Each at least 1, as the contract requires of
 * every wait it answers.
 */
export const POLL_THREAD_SECONDS = 5;
const POLL_LIST_SECONDS = 30;

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
 * - `support`, the team's hours, is absent — not null — until stage 5 brings
 *   it, which is what every server before it answers and so what a client
 *   handles anyway.
 */
export function configFor(caller: Caller, canCreate: boolean): z.input<typeof Config> {
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
    polling: { threadSeconds: POLL_THREAD_SECONDS, listSeconds: POLL_LIST_SECONDS },
  };
}
