import { z } from 'zod';
import { MAX_COMMENT } from '@/lib/csat/limits';
import { MAX_WIDGET_MESSAGE_CHARS } from '@/lib/widget/files';

/**
 * The myBlu ticket API's contract: every request, every answer, the error body,
 * the webhook and the push payload, as zod schemas.
 *
 * `plans/myblu-ticket-api.md` is the plan and this file is the contract. The
 * routes under `app/api/v1/` parse with these as they land (stages 3 to 8), and
 * `lib/api/openapi.ts` publishes them as `docs/myblu-api.openapi.json`, which the
 * app's developers and the SDK are written against before any of those routes
 * exists. So a shape changes here first, and only by addition: a field or an
 * enum value an app build already depends on is fixed from the release that
 * ships it, and a breaking change is `/api/v2` beside `/api/v1`.
 *
 * Each `const` is named as the component it publishes, so the document, the
 * guide (`docs/myblu-api.md`) and a stack trace name one thing alike, and a
 * type a caller needs is exported under the same name.
 *
 * Four rules hold over everything below, because `z.toJSONSchema` turns each
 * schema into what a generated client will enforce:
 *
 * - **An answer is a `z.looseObject`, every nested object included.** zod's
 *   default object publishes as `additionalProperties: false`, which a
 *   generated client reads as "refuse a field you do not know" — so the first
 *   field added would take every installed app down. The drift test
 *   (`openapi.test.ts`) fails on a closed object anywhere in an answer.
 * - **An enum in an answer says that values are added.** A JSON Schema `enum`
 *   is a closed list to a validator, and the statuses, the senders and the
 *   error codes all grow. The description is the contract a closed `enum`
 *   cannot state, and the drift test fails on an answer's enum without it.
 *   An enum in a request stays closed: the server refuses a value it does not
 *   know, and that refusal is the answer the client needs.
 * - **A request is a `z.object`, published as an input**, so it says what to
 *   send and is open to fields it does not name: a field the server does not
 *   know is ignored rather than refused, so an SDK newer than the server it
 *   meets still works. What a request must not say, its schema refuses.
 * - **No `z.date()` and no transform anywhere.** `z.toJSONSchema` throws on
 *   both, and the wire carries strings: an instant is ISO-8601 text in UTC, and
 *   whatever reading a route needs beyond these shapes happens in the route.
 *
 * Nothing here reads the environment or the database, so the route, the script
 * and the test import it freely.
 */

/** The phrase every enum in an answer carries; the drift test looks for it. */
const ADDED = 'Values are added without notice, and a client must accept one it does not know';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Ids are UUIDs. `z.guid()` rather than `z.uuid()`, because it reads the shape
 * `isUuid` (`lib/http/uuid.ts`) reads: a key or an id the client sends is
 * checked by that, and the published format and the server's check must agree.
 */
const id = (description: string) => z.guid().describe(description);

/** An instant: ISO-8601 in UTC, with its `Z`, as `toISOString()` writes it. */
const instant = (description: string) => z.iso.datetime().describe(description);

/** A count or a size, never negative. */
const count = (description: string) => z.int().min(0).describe(description);

/**
 * A wait or a lifetime in whole seconds, never zero. A client obeys these as
 * they come — a `pollAfterSeconds` of 0 would have it poll in a tight loop,
 * and a token or a link that lives 0 seconds is one it asks for again at once,
 * forever — so the floor is part of the contract rather than a guard every
 * build has to remember.
 */
const seconds = (description: string) => z.int().min(1).describe(description);

/**
 * The language a write is in. Exactly `ar` or `en`: the API reads no
 * `Accept-Language`, so this is the only language it is told, and what it
 * decides — the language an out-of-hours reply goes out in — is not a guess.
 */
export const Locale = z
  .enum(['ar', 'en'])
  .describe('The language the user wrote in: exactly `ar` or `en`.');

/**
 * The user's id on myBlu's side: stable for a person and never reused, and not
 * the phone. It becomes an index key and a limiter key, so its alphabet is
 * small and nothing normalises it: a value with whitespace around it is
 * refused, never trimmed, and `normaliseIdentifier`'s trim then finds nothing
 * to take. A route that trimmed before checking would accept what this refuses.
 */
export const ExternalUserId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/)
  .describe(
    "The user's id on myBlu's backend: 1 to 128 of `A-Z a-z 0-9 . _ : -`, stable for a person, never reused for another, and never the phone number.",
  );

/**
 * Strict E.164 with its plus, refused otherwise and never guessed:
 * `normalisePhone` only strips non-digits, so a national `01001234567` would
 * become a different person from `+201001234567` without a word. The app holds
 * the national form, so myBlu's backend converts before it mints.
 */
export const Phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/)
  .describe(
    'The phone number the backend verified, in strict E.164 with its plus: `+201001234567`, never the national `01001234567`.',
  );

/**
 * A tracking number as the app holds it. A claim the user makes, given back to
 * that user and to nobody else; the server links it to a parcel only when it
 * is shaped like one of ours (`detectShipmentRefs`), and returns it as sent
 * either way.
 */
export const TrackingNumber = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/)
  .describe(
    'A tracking number the ticket is about, as the app shows it: 1 to 64 of `A-Z a-z 0-9 -`. Stored as sent and returned to this user only.',
  );

/**
 * A page boundary, minted by the server and opaque to the client: base64url of
 * Postgres's own timestamp text and the row id. One this server did not mint
 * is `400 invalid_cursor`, never a first page.
 */
const Cursor = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,256}$/)
  .describe(
    'An opaque cursor this server minted. Send it back as it came; one the server did not mint is `400 invalid_cursor`.',
  );

/**
 * A page's length. Thirty by default and a hundred at most, coerced because it
 * arrives in a query string.
 */
const PageLimit = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(30)
  .describe('How many rows a page holds: 1 to 100, 30 when not given.');

/**
 * Text the user writes, never cut short: over the limit is a 400. Every limit
 * on it is counted as zod's `max` checks it and as the widget counts, in
 * UTF-16 code units, and published where a client reads it rather than
 * hard-codes it — `limitAt` names that field. JSON Schema's `maxLength` counts
 * characters instead, so a text with emoji in it can pass the published bound
 * and still be refused. The bound stays, because it never refuses a text the
 * server takes; the description says which count decides.
 */
const boundedText = (max: number, limitAt: string, description: string) =>
  z
    .string()
    .max(max)
    .describe(
      `${description} At most ${max} UTF-16 code units, as JavaScript's \`length\` counts and \`${limitAt}\` states. \`maxLength\` counts characters, so a text with emoji in it can pass that and still be refused.`,
    );

/** A message's text: `GET /config` publishes its limit. */
const messageText = (description: string) =>
  boundedText(MAX_WIDGET_MESSAGE_CHARS, 'limits.messageMaxChars', description);

/**
 * How much of a message a list row shows. Counted in UTF-16 code units, the
 * unit of every limit here, and never cut inside a surrogate pair: a cut there
 * leaves half a character, which JSON can carry only as an escaped lone
 * surrogate — drawn as a replacement mark, and refused outright by some
 * decoders — so the server stops one unit short instead.
 */
const PREVIEW_CHARS = 140;

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * Who is calling, on every client-plane request: the SDK and its version, the
 * app's version, the platform and its OS version, as `name/version` tokens.
 * It is what a `426` is decided on, and it is stored on each message the user
 * sends (`messages.meta.client`), so it says nothing about the person.
 */
export const ShipBluClientHeader = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._-]+\/[^\s/]+(?: [A-Za-z0-9._-]+\/[^\s/]+)*$/)
  .describe(
    'Required on every client-plane request: `name/version` tokens separated by spaces, the SDK first, e.g. `sdk-ts/0.3.0 app/5.4.1 ios/18.1`. A request without it is `400 invalid_request`; an SDK or app this server no longer serves is `426 client_upgrade_required`.',
  );

/**
 * Made by the SDK before a send's first attempt and reused on every retry of
 * it. Required on the two requests that write a message, because the answer
 * to either can be lost after the server stored it.
 */
export const IdempotencyKeyHeader = id(
  'Required on the two requests that write a message: a UUID the client makes before the first attempt and sends again, unchanged, on every retry of that send.',
);

/** Repeated in an error's body, so a bug report names one log line. */
export const RequestIdHeader = z
  .string()
  .describe(
    'On every answer: an opaque id for this request, repeated in an error body. Quote it in a bug report.',
  );

export const CacheControlHeader = z
  .literal('no-store')
  .describe(
    'On every answer: nothing this API returns may be cached by anything between it and the app.',
  );

export const IdempotentReplayedHeader = z
  .literal('true')
  .describe(
    'On a `200` that answers a retried send: the message was stored by an earlier attempt under the same key, and this is what it stored.',
  );

export const RetryAfterHeader = z
  .int()
  .min(1)
  .describe('On a `429`: whole seconds to wait before asking again.');

// ---------------------------------------------------------------------------
// Answers: the things themselves
// ---------------------------------------------------------------------------

/**
 * The status's category, never the status: an admin can add statuses, and
 * every one of them rolls up to one of these.
 */
export const TicketStatus = z
  .enum(['open', 'pending', 'resolved', 'closed'])
  .describe(
    `The ticket's state. ${ADDED}; a client draws one it does not know as it draws \`open\`. \`resolved\` takes a reply, which reopens the ticket; \`closed\` does not.`,
  );

/** The widget's mapping, with `customer` for its `visitor`. */
export const MessageFrom = z
  .enum(['customer', 'agent', 'system'])
  .describe(
    `Who wrote the message: \`customer\` is the user, \`agent\` a person on the support team, \`system\` nobody (an automated reply). ${ADDED}; a client draws one it does not know as \`system\`, which claims nobody wrote it.`,
  );

/**
 * The rows `csat_surveys.status` can hold that the app may see. Its fourth
 * value, `skipped`, is a survey the team decided not to send, and to the app it
 * is no survey: `GET /tickets/{id}/survey` answers `404` for it, as for none.
 */
export const SurveyStatus = z
  .enum(['sent', 'answered', 'expired'])
  .describe(
    `\`sent\`: waiting for a rating. \`answered\`: rated, and a comment may still be added. \`expired\`: can no longer be answered. ${ADDED}; a client treats one it does not know as \`expired\`.`,
  );

export const Attachment = z
  .looseObject({
    id: id('The attachment; `GET /attachments/{id}` gives a link to its bytes.'),
    filename: z
      .string()
      .describe('The name it was sent under, cleaned of anything a path could use.'),
    contentType: z
      .string()
      .describe('What the server read from the bytes, never what the sender labelled them.'),
    sizeBytes: count('Its size in bytes.'),
  })
  .describe('A file on a message, in the order it was sent.');

export const Message = z
  .looseObject({
    id: id('The message. Merge by it: a page may repeat a row the client already holds.'),
    from: MessageFrom,
    text: z
      .string()
      .describe(
        'Words somebody wrote, never a label of ours: `""` for a message sent as files alone.',
      ),
    createdAt: instant('When the server stored it.'),
    clientId: z
      .guid()
      .nullable()
      .describe(
        "The `Idempotency-Key` the user's own message was sent under, on every read and not only the send's answer, so an outbox matches a message whose answer was lost. Null on a message the user did not send.",
      ),
    attachments: z
      .array(Attachment)
      .describe('Files on the message, in order; empty when there are none.'),
  })
  .describe(
    'One message on a ticket. Only replies are ever returned: never a note, an event or a forward.',
  );

export const Preview = z
  .looseObject({
    from: MessageFrom,
    text: z
      .string()
      .describe(
        `Its text, or its first ${PREVIEW_CHARS} UTF-16 code units when longer, as JavaScript's \`length\` counts — one fewer where the ${PREVIEW_CHARS}th would split a surrogate pair, so it never ends in half a character. \`""\` for a message sent as files alone.`,
      ),
    hasAttachments: z.boolean().describe('Whether it carries files.'),
  })
  .describe("The ticket's newest message, for a list row.");

export const TicketSurveySummary = z
  .looseObject({ status: SurveyStatus })
  .describe(
    "Whether the ticket has a survey, so a list can prompt without a call per ticket; `GET /tickets/{id}/survey` reads it whole. Always null until the survey's stage ships.",
  );

/**
 * A named field list, built fresh on the server as `publicTracking()` is, with
 * no assignee, group, priority, category, tag, custom field, SLA date or event.
 * A field an agent's screen has and this does not is not an omission.
 */
export const Ticket = z
  .looseObject({
    id: id('The ticket.'),
    number: z.int().min(1).describe('The number an agent and the user can both quote.'),
    subject: z
      .string()
      .nullable()
      .describe(
        "The opening message's first words; null when it had none, such as a ticket opened with a photo, and the app draws its own title.",
      ),
    trackingNumber: TrackingNumber.nullable().describe(
      'The tracking number the ticket was opened with, as sent, or null. Never one an agent added.',
    ),
    status: TicketStatus,
    statusLabel: z
      .string()
      .nullable()
      .describe(
        'A label the support team typed for this status, in one language, shown as written; null when there is none, and the client uses its own word for `status`.',
      ),
    canReply: z
      .boolean()
      .describe('Whether a message may be sent on it now; false once it is `closed`.'),
    createdAt: instant('When it was opened.'),
    lastMessageAt: instant('When its newest message was stored; the list is ordered by it.'),
    unreadCount: count("The team's messages on it the user has not marked read."),
    preview: Preview.nullable().describe(
      "The ticket's newest message, for a list row; null only for a ticket with no message the app may read.",
    ),
    survey: TicketSurveySummary.nullable(),
  })
  .describe('A ticket the signed-in user opened from the app.');

export const SupportHours = z
  .looseObject({
    online: z.boolean().describe('Whether the support team is working now, by its own hours.'),
    opensAt: z.iso
      .datetime()
      .nullable()
      .describe(
        "When it next opens, while it is closed; null while it is open or when the team's hours are not set.",
      ),
    timezone: z
      .string()
      .nullable()
      .describe(
        "The IANA zone the team's hours are kept in, e.g. `Africa/Cairo`; null when its hours are not set.",
      ),
  })
  .describe('The support team\'s hours, for a line such as "we reply from 9:00".');

/**
 * What a screen starts from before it has asked anything else. `user.id` is
 * the identity's id, which a contact merge does not change: a contact's id here
 * would wipe an app's store whenever an agent merged a duplicate.
 */
export const Config = z
  .looseObject({
    user: z
      .looseObject({
        id: id(
          "The signed-in user's id here, which a contact merge does not change. A client keeps it in the store it namespaces by `externalId`; when it changes, the user's identity here was removed and made again, and the client wipes its cached tickets and messages.",
        ),
        externalId: ExternalUserId.describe(
          "The id myBlu's backend minted the session for. A client that asked for another user discards the token.",
        ),
      })
      .describe('Who the session belongs to.'),
    tickets: z
      .looseObject({
        canCreate: z
          .boolean()
          .describe('Whether `POST /tickets` is open now; when false, hide the new-ticket button.'),
        maxOpen: count('How many open or pending tickets one user may have at once.'),
      })
      .describe('Creating tickets.'),
    limits: z
      .looseObject({
        messageMaxChars: count('The longest message text, in UTF-16 code units.'),
        maxFiles: count('The most files on one message.'),
        maxFileBytes: count('The largest one file, in bytes.'),
        maxTotalBytes: count("The largest all of one message's files together, in bytes."),
        contentTypes: z
          .array(z.string())
          .describe('The `Content-Type` labels a file part may carry.'),
        extensions: z
          .array(z.string())
          .describe(
            'The filename extensions, without the dot, that admit a file labelled `application/octet-stream` or not at all.',
          ),
      })
      .describe(
        'What a send may carry. They move with the server, so a client checks against these rather than numbers of its own.',
      ),
    support: SupportHours.optional().describe(
      "The support team's hours. Absent until the stage that carries them ships; a client draws nothing for it then.",
    ),
    polling: z
      .looseObject({
        threadSeconds: seconds(
          'Seconds between polls of an open thread, until an answer says otherwise. At least 1.',
        ),
        listSeconds: seconds(
          'Seconds between polls of the ticket list, until an answer says otherwise. At least 1.',
        ),
      })
      .describe("What a screen polls at before its first answer's `pollAfterSeconds`."),
  })
  .describe(
    'Who is signed in and what the server allows, read on start and after every new token.',
  );

/** The survey's locale can differ from the app's: it is worded on the server, in the ticket's language. */
const SurveyLocale = z
  .enum(['ar', 'en'])
  .describe(`The language the survey is worded in, which can differ from the app's. ${ADDED}.`);

export const Survey = z
  .looseObject({
    id: id('The survey.'),
    status: SurveyStatus,
    rating: z.int().min(1).max(5).nullable().describe('The rating kept, 1 to 5; null until rated.'),
    comment: z.string().nullable().describe('The comment kept; null until one is added.'),
    locale: SurveyLocale,
    intro: z.string().describe('A first line, such as "Your ticket is resolved."'),
    question: z.string().describe('The question.'),
    labels: z
      .array(z.string())
      .length(5)
      .describe('Five words for the ratings 1 to 5, in order: very bad, bad, okay, good, great.'),
    commentPrompt: z.string().describe("The comment box's label."),
    commentMaxChars: z
      .int()
      .min(1)
      .describe(
        "The longest comment kept, in UTF-16 code units, as JavaScript's `length` counts: stop the comment box there. A longer comment is `400 invalid_request`, never cut short. On the survey, beside the box's other words, so a client checks against this rather than a number of its own.",
      ),
    button: z.string().describe("The confirm button's label."),
    thanks: z.string().describe('What to show once it is answered.'),
    expiresAt: z.iso
      .datetime()
      .nullable()
      .describe('When it can no longer be answered; null when it does not lapse.'),
  })
  .describe(
    'The satisfaction survey on a resolved ticket, worded on the server. The first rating wins whichever way it came, so draw the rating this returns, not the one tapped.',
  );

// ---------------------------------------------------------------------------
// Answers: the envelopes each operation returns
// ---------------------------------------------------------------------------

/**
 * The server plane's mint. `expiresInSeconds` beside `expiresAt` because a
 * client measures the token's life on its own monotonic clock from the moment
 * the answer arrived, never against `expiresAt` and the device's date.
 */
export const Session = z
  .looseObject({
    token: z
      .string()
      .describe(
        'The session token, `sbu_` and then an opaque string. Hand it to the app and nothing else: never log it or store it.',
      ),
    expiresAt: instant('When it stops working: twenty-four hours from minting, with no refresh.'),
    expiresInSeconds: seconds(
      "The same, as seconds from this answer, at least 1: measure it on the client's own monotonic clock, never against `expiresAt` and the device's date.",
    ),
  })
  .describe('A session for one user, minted by the server plane.');

export const TicketEnvelope = z.looseObject({ ticket: Ticket }).describe('One ticket.');

export const SendResult = z
  .looseObject({ ticket: Ticket, message: Message })
  .describe('The message as stored, and its ticket after it.');

export const MessagesPage = z
  .looseObject({
    messages: z
      .array(Message)
      .describe('Ascending by `(createdAt, id)` whichever way was asked. Merge by `id`.'),
    olderCursor: Cursor.nullable().describe(
      'Send as `before` for the page before this one; null at the start of the thread.',
    ),
    newerCursor: Cursor.describe(
      'Send as `after` to poll for newer messages. Never null, and unchanged when nothing is new; a full page means ask again at once.',
    ),
    ticket: Ticket,
    unreadTotal: count("The team's unread messages across all of the user's tickets, for a badge."),
    pollAfterSeconds: seconds(
      'Seconds to wait before the next poll of this thread, at least 1. Obey it.',
    ),
  })
  .describe("A page of a ticket's messages.");

export const TicketsPage = z
  .looseObject({
    tickets: z
      .array(Ticket)
      .describe(
        'Newest first, by `(lastMessageAt, id)`. Merge by `id`: a ticket that moves can appear twice.',
      ),
    olderCursor: Cursor.nullable().describe(
      'Send as `before` for the next, older page; null at the end of the list.',
    ),
    unreadTotal: count("The team's unread messages across all of the user's tickets, for a badge."),
    pollAfterSeconds: seconds(
      'Seconds to wait before re-reading the first page, at least 1. Obey it.',
    ),
  })
  .describe(
    "A page of the user's tickets. It has no `after`: a ticket with a new message moves to the top, so the list is polled by re-reading its first page.",
  );

export const ReadResult = z
  .looseObject({
    ticket: Ticket,
    unreadTotal: count("The team's unread messages across all of the user's tickets, after this."),
  })
  .describe('The ticket after marking it read, and the new badge.');

export const AttachmentLink = z
  .looseObject({
    url: z
      .url()
      .describe(
        "A short-lived link to the file's bytes on another host. Use it at once; never log it, store it or send the session's bearer to it. A `403` from it means ask again.",
      ),
    expiresInSeconds: seconds('How long the link works for, from this answer: at least 1.'),
  })
  .describe('Where to fetch an attachment.');

export const SurveyEnvelope = z.looseObject({ survey: Survey }).describe("A ticket's survey.");

/**
 * The contract itself, as `GET /openapi.json` serves it. Named only as far as a
 * reader needs to know which document it holds; the rest is the document.
 */
export const OpenApiDocument = z
  .looseObject({
    openapi: z.string().describe('`3.1.0`.'),
    info: z
      .looseObject({
        title: z.string(),
        version: z
          .string()
          .describe('The date of the newest line in the changelog, `docs/myblu-api-changelog.md`.'),
      })
      .describe("The document's title and version."),
  })
  .describe('This document: the OpenAPI 3.1 contract of the server answering.');

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every refusal the API can give, by code. One shape for all of them, where the
 * widget's routes answer five: a client branches on `code`, and on the HTTP
 * status for a code it does not know.
 */
export const ErrorCode = z
  .enum([
    'invalid_request',
    'invalid_cursor',
    'idempotency_key_required',
    'empty_message',
    'file_refused',
    'unauthenticated',
    'session_expired',
    'blocked',
    'not_found',
    'ticket_closed',
    'too_many_open',
    'key_reused',
    'length_required',
    'too_large',
    'client_upgrade_required',
    'rate_limited',
    'internal',
    'upload_failed',
    'not_configured',
  ])
  .describe(
    `Why the request was refused. ${ADDED}: a client classifies a code it does not know by the HTTP status it came with.`,
  );

export type ErrorCode = z.output<typeof ErrorCode>;

/**
 * The status each code is answered with. Part of the contract, not of a route:
 * a client that meets a code it does not know falls back to the status, so a
 * code never moves to another one.
 */
export const ERROR_STATUS = {
  invalid_request: 400,
  invalid_cursor: 400,
  idempotency_key_required: 400,
  empty_message: 400,
  file_refused: 400,
  unauthenticated: 401,
  session_expired: 401,
  blocked: 403,
  not_found: 404,
  ticket_closed: 409,
  too_many_open: 409,
  key_reused: 409,
  length_required: 411,
  too_large: 413,
  client_upgrade_required: 426,
  rate_limited: 429,
  internal: 500,
  upload_failed: 502,
  not_configured: 503,
} as const satisfies Record<ErrorCode, number>;

/** The widget's own refusals (`WidgetFileRefusal`), published by name. */
export const FileRefusalReason = z
  .enum(['too_many', 'too_large', 'too_large_total', 'type', 'empty'])
  .describe(
    `On \`file_refused\`: \`too_many\` files, one \`too_large\`, all of them \`too_large_total\`, a \`type\` the server does not carry, or an \`empty\` file. ${ADDED}.`,
  );

export const ErrorDetail = z
  .looseObject({
    code: ErrorCode,
    message: z
      .string()
      .describe(
        "A sentence in English for a developer's log. Never shown to the user, and never parsed.",
      ),
    requestId: z.string().describe('The `ShipBlu-Request-Id` this answer carried.'),
    field: z
      .string()
      .optional()
      .describe(
        'On `invalid_request`, when one field is to blame: its name, as the request spelled it (a body field, a query parameter, a header).',
      ),
    reason: FileRefusalReason.optional(),
    filename: z
      .string()
      .nullable()
      .optional()
      .describe(
        'On `file_refused`: the file refused, or null when the refusal is about all of them.',
      ),
  })
  .describe('What went wrong.');

export const ErrorBody = z
  .looseObject({ error: ErrorDetail })
  .describe('Every refusal, whatever its status.');

export type ErrorBody = z.output<typeof ErrorBody>;

// ---------------------------------------------------------------------------
// Requests: the server plane
// ---------------------------------------------------------------------------

export const Platform = z.enum(['ios', 'android']).describe('The platform the app runs on.');

/**
 * Minted by myBlu's backend when its app asks for support, never by the app:
 * a value compiled into an app binary is extractable, and whoever extracts it
 * is every recipient. The name is used only for a contact this creates.
 */
export const CreateSessionRequest = z
  .object({
    externalUserId: ExternalUserId,
    phone: Phone,
    name: z
      .string()
      .max(200)
      .optional()
      // Counted as every limit on text here is, in UTF-16 code units. Nothing
      // publishes it for a client to read, since only the backend sends it, so
      // the description is where the backend learns which count decides.
      .describe(
        "The user's name, used only when this creates the contact; a name the contact already has is never overwritten. At most 200 UTF-16 code units, as JavaScript's `length` counts: `maxLength` counts characters, as Python's `len` does, so a name with emoji in it can pass that and still be refused `400 invalid_request`.",
      ),
    client: z
      .object({
        platform: Platform,
        appVersion: z.string().min(1).max(32).describe('The app version asking, e.g. `5.4.1`.'),
      })
      .describe('The app the session is for.'),
  })
  .describe('Mint a session for one user.');

export const RevokeReason = z
  .enum(['signed_out', 'phone_changed', 'account_deleted', 'number_released', 'other'])
  .describe(
    "`signed_out` everywhere; `phone_changed`; `account_deleted`; `number_released`, the number now somebody else's; or `other`. With `account_deleted` or `number_released` the user's tickets also leave the app for good.",
  );

export const RevokeSessionsRequest = z
  .object({ externalUserId: ExternalUserId, reason: RevokeReason })
  .describe('End every session of one user, on every device.');

// ---------------------------------------------------------------------------
// Requests: the client plane
// ---------------------------------------------------------------------------

export const CreateTicketRequest = z
  .object({
    text: messageText(
      'What the user wrote. Required in JSON; blank is `400 empty_message`, and over the limit `400 invalid_request`, never cut short.',
    ),
    locale: Locale,
    trackingNumber: TrackingNumber.optional(),
  })
  .describe('Open a ticket with its first message.');

/**
 * The same request with files, accepted from the files stage (stage 7). Before
 * it, a multipart body is `400 invalid_request`. The parts are named as the
 * JSON fields are — the widget's own text part is `body`; here it is `text` in
 * both encodings — and `files` repeats, one part per file in the order to show
 * them.
 */
export const CreateTicketMultipart = z
  .object({
    text: messageText(
      'What the user wrote; may be empty or left out when there is a file.',
    ).optional(),
    locale: Locale,
    trackingNumber: TrackingNumber.optional(),
    files: z
      .array(z.file())
      .optional()
      .describe(
        'Repeated, one part per file in the order to show them. Each part carries its filename and a `Content-Type` from `GET /config`; one with none, or `application/octet-stream`, is admitted by its extension.',
      ),
  })
  .describe(
    'Open a ticket with files. Accepted from the files stage; before it, a multipart body is `400 invalid_request`. `Content-Length` is required (`411` without it).',
  );

export const SendMessageRequest = z
  .object({
    text: messageText(
      'What the user wrote. Required in JSON; blank is `400 empty_message`, and over the limit `400 invalid_request`, never cut short.',
    ),
    locale: Locale,
  })
  .describe('Send a message on a ticket.');

export const SendMessageMultipart = z
  .object({
    text: messageText(
      'What the user wrote; may be empty or left out when there is a file.',
    ).optional(),
    locale: Locale,
    files: z
      .array(z.file())
      .optional()
      .describe(
        'Repeated, one part per file in the order to show them. Each part carries its filename and a `Content-Type` from `GET /config`; one with none, or `application/octet-stream`, is admitted by its extension.',
      ),
  })
  .describe(
    'Send a message with files. Accepted from the files stage; before it, a multipart body is `400 invalid_request`. `Content-Length` is required (`411` without it).',
  );

export const MarkReadRequest = z
  .object({
    upTo: id(
      "The newest message on screen: any message this API returned on this ticket, the user's own included. Marking twice, or backwards, changes nothing.",
    ),
  })
  .describe("Mark the team's messages read, up to one.");

export const AnswerSurveyRequest = z
  .object({
    rating: z.int().min(1).max(5).describe('1 to 5. Posted when tapped; the first rating wins.'),
    comment: boundedText(
      MAX_COMMENT,
      'survey.commentMaxChars',
      'A comment, sent as a second `POST` carrying the same rating. Over the limit is `400 invalid_request`, never cut short.',
    ).optional(),
  })
  .describe('Answer the survey.');

// ---------------------------------------------------------------------------
// Query parameters and path ids
// ---------------------------------------------------------------------------

export const TicketId = id('A ticket the signed-in user opened. Anything else is `404 not_found`.');

export const AttachmentId = id(
  "An attachment on one of the signed-in user's tickets. Anything else is `404 not_found`.",
);

/**
 * `after` and `before` are each optional and never both: together they are
 * `400 invalid_request`. With neither, the newest page — the existing read
 * models are `orderBy(asc).limit(200)`, which silently stops showing a long
 * conversation's new replies.
 */
export const ListMessagesQuery = z
  .object({
    after: Cursor.optional().describe('A `newerCursor`: the messages after it. Not with `before`.'),
    before: Cursor.optional().describe('An `olderCursor`: the page before it. Not with `after`.'),
    limit: PageLimit,
  })
  .describe("Which page of a ticket's messages. With no cursor, the newest page.");

export const ListTicketsQuery = z
  .object({
    before: Cursor.optional().describe('An `olderCursor`: the next, older page.'),
    limit: PageLimit,
    trackingNumber: TrackingNumber.optional().describe(
      'Only tickets opened with this tracking number, so a shipment screen finds its ticket after a reinstall.',
    ),
  })
  .describe("Which page of the user's tickets.");

// ---------------------------------------------------------------------------
// The webhook, and the push it becomes
// ---------------------------------------------------------------------------

/**
 * Ids only, in the body as in the job: the body is rebuilt from the rows when
 * it is sent, so text purged before a retry lands is never sent late. Never the
 * phone, which stays out of a third system's request log, and the user's
 * external id read off the ticket's ownership row, never off the contact.
 */
const webhookBase = {
  version: z.literal(1).describe("The body's shape: `1` on every event `/api/v1` sends."),
  id: z
    .string()
    .describe(
      'The event, `<type>:<subject id>`, the same on every attempt. Dedupe on it for a day: an event can arrive more than once.',
    ),
  occurredAt: instant('When the thing it reports happened, not when this attempt was sent.'),
  user: z
    .looseObject({
      externalId: ExternalUserId.describe("The ticket's user, as the backend minted them."),
    })
    .describe('Whose ticket it is.'),
  ticket: z
    .looseObject({
      id: id('The ticket.'),
      number: z.int().min(1).describe("The ticket's number."),
      status: TicketStatus,
    })
    .describe('The ticket it is about.'),
};

export const MessageCreatedEvent = z
  .looseObject({
    ...webhookBase,
    type: z
      .literal('message.created')
      .describe("A message from the team on one of the user's tickets."),
    message: z
      .looseObject({
        id: id('The message; read it with `GET /tickets/{id}/messages`.'),
        from: MessageFrom,
      })
      .describe('The message, by id. Its text is never in the webhook.'),
  })
  .describe("Sent when the team writes to the user: a person's reply or an automated one.");

export const SurveyCreatedEvent = z
  .looseObject({
    ...webhookBase,
    type: z.literal('survey.created').describe("A survey is waiting on one of the user's tickets."),
    survey: z
      .looseObject({
        id: id('The survey; read it with `GET /tickets/{id}/survey`.'),
        expiresAt: z.iso
          .datetime()
          .nullable()
          .describe('When it can no longer be answered; null when it does not lapse.'),
      })
      .describe('The survey, by id.'),
  })
  .describe("Sent when a resolved ticket's survey is ready. From the survey's stage (stage 8).");

/**
 * Any event, by what every type carries: the arm a type added after a receiver
 * was built matches. Its `type` is any string, because an enum or a `const`
 * there would close the union again.
 */
export const AnyWebhookEvent = z
  .looseObject({
    ...webhookBase,
    type: z
      .string()
      .describe("The event's type: one `WebhookEventType` names, or one added since."),
  })
  .describe(
    'Any event, by the fields every type carries: what a receiver reads of a type it does not know, and answers `2xx` without acting on.',
  );

/**
 * Every event the one receiver URL gets, told apart by `type`. The survey's
 * event is a second arm beside the reply's rather than a changed shape, as the
 * job that sends them (`notify_myblu`, stage 6) keys its own strict payload.
 *
 * A plain union, published as `anyOf`, with `AnyWebhookEvent` as its last arm,
 * and not a discriminated union. That publishes as a `oneOf` of `const` types
 * with a mapping, which a receiver validating against the document, or
 * deserialising through a model generated from it, reads as a closed list: an
 * event of a new type fails it, the receiver answers an error, and the sender
 * retries until it gives up, the reverse of the guide's "answer `2xx` to a type
 * you do not know". Under `anyOf` a known event matches its own arm and the
 * open one, which is allowed; under `oneOf` it would match two and be refused.
 */
export const WebhookEvent = z
  .union([MessageCreatedEvent, SurveyCreatedEvent, AnyWebhookEvent])
  .describe(
    `One event, by \`type\`. ${ADDED}: a receiver answers 2xx to a type it does not know and does nothing with it. Such an event matches \`AnyWebhookEvent\`, the last arm, which every event matches.`,
  );

export const WebhookEventType = z
  .enum(['message.created', 'survey.created'])
  .describe(`The event's type, also in \`X-ShipBlu-Event\`. ${ADDED}.`);

/**
 * `v1=` and the hex HMAC-SHA256 of `<timestamp>.<raw body>`. Two of them,
 * comma-separated, while a secret is being rotated; the receiver accepts
 * either.
 */
export const WebhookSignatureHeader = z
  .string()
  .regex(/^v1=[0-9a-f]{64}(?:,v1=[0-9a-f]{64})*$/)
  .describe(
    '`v1=` and the lowercase hex HMAC-SHA256, under the shared secret, of the `X-ShipBlu-Timestamp` value, a `.`, and the raw body. While a secret is rotated, two of them separated by a comma; accept the request when either matches.',
  );

export const WebhookTimestampHeader = z
  .string()
  .regex(/^\d{1,12}$/)
  .describe(
    "Unix seconds when this attempt was signed: a retry carries its own. Refuse one more than five minutes from the receiver's clock.",
  );

export const WebhookEventIdHeader = z.string().describe("The body's `id`.");

/**
 * What myBlu's backend forwards to a device for each webhook event, as an FCM
 * data payload: every value a string, as FCM requires. The visible title and
 * body are the backend's, in the user's language, beside exactly these keys.
 * Open all the same: keys are added here, and the app hands `push.handle`
 * whatever its notification carries — a copy it draws itself carries its own
 * marker beside these — so `push.handle` ignores any key it does not know.
 */
export const PushData = z
  .looseObject({
    sb_v: z.literal('1').describe('`"1"`. A payload without it is not ours.'),
    sb_type: z
      .enum(['message.created', 'survey.created'])
      .describe(`The webhook event's \`type\`. ${ADDED}.`),
    sb_event_id: z
      .string()
      .describe(
        "The webhook event's `id`. The app hands a client the same push when it arrives and again when it is tapped: the client answers the ticket both times, and fetches for an `id` only the first time.",
      ),
    sb_user: ExternalUserId.describe(
      "The webhook's `user.externalId`. A client ignores a push for any user but the one signed in.",
    ),
    sb_ticket_id: id("The webhook's `ticket.id`."),
    sb_ticket_number: z
      .string()
      .regex(/^\d+$/)
      .describe("The webhook's `ticket.number`, as a string."),
    sb_message_id: id("The webhook's `message.id`, on `message.created`.").optional(),
    sb_survey_id: id("The webhook's `survey.id`, on `survey.created`.").optional(),
  })
  .describe(
    "The data keys myBlu's backend puts on the push it sends for each webhook event, every value a string. `push.handle` ignores any other key on the payload it is handed, such as one the app adds to a notification it draws itself.",
  );
