import { z } from 'zod';
import {
  AnswerSurveyRequest,
  AnyWebhookEvent,
  Attachment,
  AttachmentId,
  AttachmentLink,
  CacheControlHeader,
  Config,
  CreateSessionRequest,
  CreateTicketMultipart,
  CreateTicketRequest,
  ERROR_STATUS,
  ErrorBody,
  ErrorCode,
  ErrorDetail,
  ExternalUserId,
  FileRefusalReason,
  IdempotencyKeyHeader,
  IdempotentReplayedHeader,
  ListMessagesQuery,
  ListTicketsQuery,
  Locale,
  MarkReadRequest,
  Message,
  MessageCreatedEvent,
  MessageFrom,
  MessagesPage,
  OpenApiDocument,
  Phone,
  Platform,
  Preview,
  PushData,
  ReadResult,
  RequestIdHeader,
  RetryAfterHeader,
  RevokeReason,
  RevokeSessionsRequest,
  SendMessageMultipart,
  SendMessageRequest,
  SendResult,
  Session,
  ShipBluClientHeader,
  SupportHours,
  Survey,
  SurveyCreatedEvent,
  SurveyEnvelope,
  SurveyStatus,
  Ticket,
  TicketEnvelope,
  TicketId,
  TicketStatus,
  TicketSurveySummary,
  TicketsPage,
  TrackingNumber,
  WebhookEvent,
  WebhookEventIdHeader,
  WebhookEventType,
  WebhookSignatureHeader,
  WebhookTimestampHeader,
} from '@/lib/api/schemas';
import { MAX_COMMENT } from '@/lib/csat/limits';
import {
  MAX_WIDGET_FILES,
  MAX_WIDGET_FILE_BYTES,
  MAX_WIDGET_MESSAGE_CHARS,
  MAX_WIDGET_REQUEST_BYTES,
  MAX_WIDGET_TOTAL_BYTES,
} from '@/lib/widget/files';

/**
 * The myBlu ticket API's OpenAPI 3.1 document, built from `lib/api/schemas.ts`.
 *
 * Three things read it: `GET /api/v1/openapi.json`, which serves the contract of
 * the server answering; `npm run api:openapi`, which writes it to
 * `docs/myblu-api.openapi.json` for the app's developers, their mock and the
 * SDK; and `openapi.test.ts`, which fails when that committed file and this
 * builder disagree. It imports every schema by name — never `import * as` —
 * so each is a live export before its route exists, and `dead-exports` keeps
 * asking the question for real once the routes import them too.
 *
 * `z.toJSONSchema` does the schemas, with no new dependency: zod 4.4.3 emits
 * draft 2020-12, which OpenAPI 3.1 takes as it stands. Requests are converted
 * as inputs and answers as outputs, in two registries, because the same rule
 * reads differently on the two sides — a default makes a request field
 * optional and an answer's field present. What `tidy` takes out of zod's output
 * is noise, never meaning: the regex zod writes beside `format: uuid` and
 * `format: date-time`, which states the format a second time in a form nobody
 * reads, and the safe-integer bounds on every integer.
 *
 * Every example is parsed with the schema it illustrates as the document is
 * built, so a document with a wrong example cannot be built, served or
 * committed: the example is the first thing an app developer copies.
 */

/** The date of the newest line in `docs/myblu-api-changelog.md`; the test holds the two together. */
const CONTRACT_VERSION = '2026-11-13';

const TITLE = 'ShipBlu Support: the myBlu ticket API';

type Json = Record<string, unknown>;

const schemaRef = (id: string) => ({ $ref: `#/components/schemas/${id}` });

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** Published as outputs: what the server answers, sends to the webhook, and puts in a push. */
const ANSWERS = {
  TicketStatus,
  MessageFrom,
  SurveyStatus,
  Attachment,
  Message,
  Preview,
  TicketSurveySummary,
  Ticket,
  SupportHours,
  Config,
  Survey,
  Session,
  TicketEnvelope,
  SendResult,
  MessagesPage,
  TicketsPage,
  ReadResult,
  AttachmentLink,
  SurveyEnvelope,
  OpenApiDocument,
  ErrorCode,
  FileRefusalReason,
  ErrorDetail,
  ErrorBody,
  WebhookEventType,
  MessageCreatedEvent,
  SurveyCreatedEvent,
  AnyWebhookEvent,
  WebhookEvent,
  PushData,
} satisfies Record<string, z.ZodType>;

/** Published as inputs: what a caller sends. */
const REQUESTS = {
  Locale,
  Platform,
  RevokeReason,
  ExternalUserId,
  Phone,
  TrackingNumber,
  CreateSessionRequest,
  RevokeSessionsRequest,
  CreateTicketRequest,
  CreateTicketMultipart,
  SendMessageRequest,
  SendMessageMultipart,
  MarkReadRequest,
  AnswerSurveyRequest,
} satisfies Record<string, z.ZodType>;

type ToJsonParams = NonNullable<Parameters<typeof z.toJSONSchema>[1]>;
type Override = NonNullable<ToJsonParams['override']>;

/**
 * No `discriminator` is added to `WebhookEvent`: OpenAPI 3.1 has no default
 * arm for one, so a generated model would refuse a `type` its mapping does not
 * name, which is the closed union `schemas.ts` says the webhook must not be.
 */
const tidy: Override = ({ jsonSchema }) => {
  const json = jsonSchema as Json;
  if (json.format === 'uuid' || json.format === 'date-time') delete json.pattern;
  if (json.maximum === Number.MAX_SAFE_INTEGER) delete json.maximum;
  if (json.minimum === Number.MIN_SAFE_INTEGER) delete json.minimum;
};

/** A component's JSON Schema, without the `$schema` and `$id` a standalone document needs and a component must not carry. */
function component(json: Json): Json {
  const { $schema: _schema, $id: _id, ...rest } = json;
  return rest;
}

function registryOf(schemas: Record<string, z.ZodType>) {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(schemas)) registry.add(schema, { id });
  return registry;
}

function componentSchemas(): Json {
  const uri = (id: string) => schemaRef(id).$ref;
  const answers = z.toJSONSchema(registryOf(ANSWERS), { io: 'output', uri, override: tidy });
  const requests = z.toJSONSchema(registryOf(REQUESTS), { io: 'input', uri, override: tidy });

  const out: Json = {};
  for (const [id, json] of [
    ...Object.entries(answers.schemas),
    ...Object.entries(requests.schemas),
  ]) {
    if (id in out) throw new Error(`Two components are named ${id}`);
    out[id] = component(json as Json);
  }
  return out;
}

/**
 * One schema on its own, for a parameter or a header. Its description moves up
 * to the parameter, where a reader looks for it, rather than being said twice.
 */
function inlineSchema(
  schema: z.ZodType,
  io: 'input' | 'output',
): { schema: Json; description?: string } {
  const { description, ...json } = component(
    z.toJSONSchema(schema, { io, override: tidy }) as Json,
  );
  return { schema: json, description: typeof description === 'string' ? description : undefined };
}

function header(schema: z.ZodType, example?: unknown): Json {
  const { schema: json, description } = inlineSchema(schema, 'output');
  return { description, schema: json, ...(example !== undefined && { example }) };
}

function parameter(
  name: string,
  location: 'header' | 'path' | 'query',
  schema: z.ZodType,
  required: boolean,
  example?: unknown,
): Json {
  const { schema: json, description } = inlineSchema(schema, 'input');
  return {
    name,
    in: location,
    required,
    description,
    schema: json,
    ...(example !== undefined && { example }),
  };
}

/** A query object's fields as parameters, in the order the schema names them. */
function queryParameters(query: z.ZodObject): Json[] {
  return Object.entries(query.shape).map(([name, field]) =>
    parameter(name, 'query', field as z.ZodType, false),
  );
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

/** Parsed as it is built: a wrong example fails the build, never a reader. */
function example<S extends z.ZodType>(schema: S, summary: string, value: z.input<S>): Json {
  schema.parse(value);
  return { summary, value };
}

const IDS = {
  identity: 'c2a8f3e1-5b7d-4e0a-9f3c-8d1e2b4a6c70',
  ticket: '8a1f4c2e-6b3d-4f9a-a7e5-1c2d3e4f5a6b',
  opening: '0d9e8f7a-6b5c-4d3e-9f1a-2b3c4d5e6f70',
  photo: '3a2b1c0d-9e8f-4a7b-b6c5-d4e3f2a1b0c9',
  reply: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
  answer: '7b6a5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d',
  attachment: '5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170',
  openingKey: '0b7e9c2a-3d4f-4a1b-8c5d-6e7f8a9b0c1d',
  photoKey: '2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e9f',
  answerKey: '4e3d2c1b-0a9f-4e8d-a7c6-b5a4f3e2d1c0',
  survey: '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  request: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
} as const;

const EXTERNAL_ID = 'u_83412';

/**
 * A cursor as the server mints one: base64url of Postgres's timestamp text and
 * the row id. Shown so the examples look like what arrives; opaque to a client,
 * which never reads one.
 */
function cursor(timestamp: string, rowId: string): string {
  return Buffer.from(`${timestamp}|${rowId}`).toString('base64url');
}

const OPENING: z.input<typeof Message> = {
  id: IDS.opening,
  from: 'customer',
  text: 'My parcel was left with a neighbour I do not know. Can it come to me instead?',
  createdAt: '2026-11-12T09:29:58.123Z',
  clientId: IDS.openingKey,
  attachments: [],
};

const PHOTO: z.input<typeof Message> = {
  id: IDS.photo,
  from: 'customer',
  text: '',
  createdAt: '2026-11-12T09:30:02.871Z',
  clientId: IDS.photoKey,
  attachments: [
    {
      id: IDS.attachment,
      filename: 'IMG_0412.heic',
      contentType: 'image/heic',
      sizeBytes: 2_203_114,
    },
  ],
};

const REPLY: z.input<typeof Message> = {
  id: IDS.reply,
  from: 'agent',
  text: 'We have asked the courier to collect it from your neighbour and bring it to you today.',
  createdAt: '2026-11-12T09:41:07.004Z',
  clientId: null,
  attachments: [],
};

const ANSWER: z.input<typeof Message> = {
  id: IDS.answer,
  from: 'customer',
  text: 'شكرًا، هستنى المندوب.',
  createdAt: '2026-11-12T09:44:31.560Z',
  clientId: IDS.answerKey,
  attachments: [],
};

const TICKET: z.input<typeof Ticket> = {
  id: IDS.ticket,
  number: 4812,
  subject: 'My parcel was left with a neighbour I do not know. Can it come to me instead?',
  trackingNumber: '1755021358719',
  status: 'open',
  statusLabel: null,
  canReply: true,
  createdAt: '2026-11-12T09:29:58.123Z',
  lastMessageAt: '2026-11-12T09:41:07.004Z',
  unreadCount: 1,
  preview: {
    from: 'agent',
    text: 'We have asked the courier to collect it from your neighbour and bring it to you today.',
    hasAttachments: false,
  },
  survey: null,
};

/** The ticket the moment its first message is stored. */
const NEW_TICKET: z.input<typeof Ticket> = {
  ...TICKET,
  lastMessageAt: OPENING.createdAt,
  unreadCount: 0,
  preview: { from: 'customer', text: OPENING.text, hasAttachments: false },
};

/** The ticket once the user has answered and read the agent's reply. */
const ANSWERED_TICKET: z.input<typeof Ticket> = {
  ...TICKET,
  lastMessageAt: ANSWER.createdAt,
  unreadCount: 0,
  preview: { from: 'customer', text: ANSWER.text, hasAttachments: false },
};

const RESOLVED_TICKET: z.input<typeof Ticket> = {
  ...ANSWERED_TICKET,
  number: 4790,
  id: '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b',
  subject: 'Where is my refund for the returned order?',
  trackingNumber: '1754998112045',
  status: 'resolved',
  createdAt: '2026-11-09T14:02:11.418Z',
  lastMessageAt: '2026-11-10T08:15:40.200Z',
  preview: {
    from: 'agent',
    text: 'The refund was sent to your wallet this morning. Is there anything else?',
    hasAttachments: false,
  },
  survey: { status: 'sent' },
};

const SURVEY_AR: z.input<typeof Survey> = {
  id: IDS.survey,
  status: 'sent',
  rating: null,
  comment: null,
  locale: 'ar',
  intro: 'تم حل طلب حضرتك.',
  question: 'كيف كانت تجربة حضرتك مع الدعم؟',
  labels: ['سيئة جدًا', 'سيئة', 'مقبولة', 'جيدة', 'ممتازة'],
  commentPrompt: 'هل هناك ما تودّ حضرتك إضافته؟ (اختياري)',
  commentMaxChars: MAX_COMMENT,
  button: 'إرسال',
  thanks: 'شكرًا لحضرتك. تم إرسال رأيك إلى الفريق.',
  expiresAt: '2026-11-17T08:15:40.200Z',
};

/**
 * Every refusal, once, with the sentence a developer's log would hold. The
 * `when` line is what a response's description says the code means there.
 * A number a sentence quotes is read from the constant the route will check
 * against, the widget's own (`lib/widget/files.ts`), so raising a ceiling
 * moves the example with it rather than leaving it quoting the old one.
 */
const REFUSALS: Record<
  ErrorCode,
  { summary: string; message: string; when: string; extras?: Partial<z.input<typeof ErrorDetail>> }
> = {
  invalid_request: {
    summary: 'A field the request got wrong',
    message: 'locale must be "ar" or "en".',
    when: '`invalid_request`: a field, a query parameter or a header is wrong; `field` names it when one is to blame.',
    extras: { field: 'locale' },
  },
  invalid_cursor: {
    summary: 'A cursor this server did not mint',
    message: 'The cursor was not minted by this server.',
    when: '`invalid_cursor`: drop the cursor and load the newest page.',
  },
  idempotency_key_required: {
    summary: 'A send without its key',
    message: 'Idempotency-Key is required on this request, and must be a UUID.',
    when: '`idempotency_key_required`: an SDK bug, never retried.',
  },
  empty_message: {
    summary: 'Neither words nor files',
    message: 'A message needs words or a file.',
    when: '`empty_message`: neither words nor files.',
  },
  file_refused: {
    summary: 'A file over the limit',
    message: `IMG_0412.MOV is larger than ${MAX_WIDGET_FILE_BYTES} bytes.`,
    when: '`file_refused`: one file, or all of them, refused; `reason` says why and `filename` which.',
    extras: { reason: 'too_large', filename: 'IMG_0412.MOV' },
  },
  unauthenticated: {
    summary: 'No live session for this bearer',
    message: 'No live session for this bearer.',
    when: '`unauthenticated`: no bearer, a malformed one, or one with no live session. Refresh once and replay once.',
  },
  session_expired: {
    summary: 'A session past its life',
    message: 'This session expired at 2026-11-13T09:29:41.000Z.',
    when: '`session_expired`: a session past its life. Treated as `unauthenticated`.',
  },
  blocked: {
    summary: 'A user who may not use support',
    message: 'This user may not use support.',
    when: '`blocked`: the user may not use support. Never refreshed, never retried.',
  },
  not_found: {
    summary: "Not the user's, or not there",
    message: 'No such ticket for this user.',
    when: "`not_found`: not the user's, not there, deleted or merged away, all one answer.",
  },
  ticket_closed: {
    summary: 'A reply to a closed ticket',
    message: 'The ticket is closed; open a new one.',
    when: '`ticket_closed`: the ticket is closed; offer a new ticket.',
  },
  too_many_open: {
    summary: 'Too many open tickets',
    message: 'This user has 10 open or pending tickets.',
    when: '`too_many_open`: the user has as many open or pending tickets as they may. Not retried.',
  },
  key_reused: {
    summary: 'A key sent with another request',
    message: 'This Idempotency-Key was used for another request.',
    when: '`key_reused`: the key was used for another ticket or route. An SDK bug.',
  },
  length_required: {
    summary: 'A multipart body without its length',
    message: 'A multipart body must carry Content-Length.',
    when: '`length_required`: a multipart body without `Content-Length`. An SDK bug.',
  },
  too_large: {
    summary: 'A body over the ceiling',
    message: `The body is larger than ${MAX_WIDGET_REQUEST_BYTES} bytes.`,
    when: '`too_large`: the body is larger than this server reads.',
  },
  client_upgrade_required: {
    summary: 'An SDK this server no longer serves',
    message: 'sdk-ts/0.0.9 is no longer served; update the SDK.',
    when: '`client_upgrade_required`: this SDK or app is no longer served. Stop every call and tell the app once.',
  },
  rate_limited: {
    summary: 'Too many requests',
    message: 'Too many requests; wait for Retry-After.',
    when: '`rate_limited`: wait `Retry-After` seconds, then retry.',
  },
  internal: {
    summary: 'A failure on the server',
    message: 'Something failed on the server. The request id names it in the log.',
    when: '`internal`: a failure on the server. Back off and retry.',
  },
  upload_failed: {
    summary: 'A file that could not be stored',
    message: 'A file could not be stored, so nothing was. Retry the whole send under the same key.',
    when: '`upload_failed`: nothing was stored; retry the whole send under the same key.',
  },
  not_configured: {
    summary: 'Not switched on here',
    // Every operation's example, so it names the case every one of them can
    // answer: on `POST /tickets` alone it can also be opening tickets that is off.
    message: 'The API is not switched on here.',
    when: '`not_configured`: the API, or on `POST /tickets` opening tickets, is not switched on here. Not retried: a create fails, and any other call waits for the next foreground.',
  },
};

function refusalExample(code: ErrorCode): Json {
  const refusal = REFUSALS[code];
  return example(ErrorBody, refusal.summary, {
    error: { code, message: refusal.message, requestId: IDS.request, ...refusal.extras },
  });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const EVERY_ANSWER = {
  'ShipBlu-Request-Id': { $ref: '#/components/headers/RequestId' },
  'Cache-Control': { $ref: '#/components/headers/CacheControl' },
};

const STATUS_WORDS: Record<number, string> = {
  400: 'Refused as written.',
  401: 'Not authenticated.',
  403: 'Forbidden.',
  404: 'Not found.',
  409: 'In conflict with what is stored.',
  411: 'Length required.',
  413: 'Too large.',
  426: 'Upgrade required.',
  429: 'Too many requests.',
  500: 'Failed on the server.',
  502: 'A store behind the server failed.',
  503: 'Not available here.',
};

/**
 * Every client-plane operation can answer these, before it reads anything of its
 * own — but `blocked` on `DELETE /session`, which ends a blocked user's session
 * rather than refusing it.
 */
const CLIENT_PLANE: readonly ErrorCode[] = [
  'invalid_request',
  'unauthenticated',
  'session_expired',
  'blocked',
  'client_upgrade_required',
  'rate_limited',
  'internal',
  'not_configured',
];

const SERVER_PLANE: readonly ErrorCode[] = [
  'invalid_request',
  'unauthenticated',
  'rate_limited',
  'internal',
  'not_configured',
];

/**
 * What a code means where myBlu's backend meets it. The `when` lines above are
 * the SDK's — refresh and replay, wait for the next foreground — and none of
 * them is the backend's: its bearer is `MYBLU_API_TOKEN`, with no session
 * behind it to refresh, and on `POST /sessions` its app is waiting for the
 * answer. So that operation says which refusals the backend relays to the app
 * as they came and which it answers with a `502` of its own, as the guide's
 * _Minting a session_ does; read with the client plane's lines, a backend
 * would refresh a token it does not have and wait out what its app should.
 */
const NOT_THE_TOKEN =
  "`unauthenticated`: no bearer, a malformed one, or one that is not `MYBLU_API_TOKEN` as this server holds it. The backend's own bug, with no session behind it to refresh";

const MINT_REFUSALS: Partial<Record<ErrorCode, string>> = {
  invalid_request:
    "`invalid_request`: a field or a header is wrong; `field` names it when one is to blame. The backend's own bug: it answers its app with a `502` of its own.",
  unauthenticated: `${NOT_THE_TOKEN}: never retried, and answered to the app with a \`502\` of the backend's own.`,
  blocked:
    '`blocked`: the user may not use support, and nothing was minted. Relayed to the app as it came, status and body, and its SDK stops there: never retried.',
  rate_limited:
    "`rate_limited`: the server plane, or this user's minting, is over its limit. Relayed to the app as it came, `Retry-After` included, and its SDK waits that long; the backend does not wait it out itself.",
  internal:
    "`internal`: a failure on the server. Answered to the app with a `502` of the backend's own, and the app asks again on its next foreground.",
  not_configured:
    '`not_configured`: the API is not switched on here, and nothing was minted. Relayed to the app as it came, and its SDK holds its outbox until the next foreground: never retried.',
};

const REVOKE_REFUSALS: Partial<Record<ErrorCode, string>> = {
  unauthenticated: `${NOT_THE_TOKEN}: a retry is refused the same way.`,
  not_configured:
    '`not_configured`: the API is not switched on here, and every session is refused while it is off. A session minted before works again if the API is switched back on within its day, so send the revoke again later.',
};

/** The refusals an operation can give, grouped under their statuses, each example by reference. */
function refusals(
  codes: readonly ErrorCode[],
  when: Partial<Record<ErrorCode, string>> = {},
): Json {
  const ordered = ErrorCode.options.filter((code) => codes.includes(code));
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of ordered) {
    const status = ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }

  const out: Json = {};
  for (const [status, group] of [...byStatus].sort(([a], [b]) => a - b)) {
    out[String(status)] = {
      description: [
        STATUS_WORDS[status],
        ...group.map((code) => when[code] ?? REFUSALS[code].when),
      ].join(' '),
      headers:
        status === 429
          ? { ...EVERY_ANSWER, 'Retry-After': { $ref: '#/components/headers/RetryAfter' } }
          : EVERY_ANSWER,
      content: {
        'application/json': {
          schema: schemaRef('ErrorBody'),
          examples: Object.fromEntries(
            group.map((code) => [code, { $ref: `#/components/examples/${code}` }]),
          ),
        },
      },
    };
  }
  return out;
}

type Answer = {
  status: number;
  description: string;
  schema?: string;
  examples?: Record<string, Json>;
  replayed?: boolean;
};

function answer({ status, description, schema, examples, replayed }: Answer): Json {
  return {
    [String(status)]: {
      description,
      headers: replayed
        ? {
            ...EVERY_ANSWER,
            'Idempotent-Replayed': { $ref: '#/components/headers/IdempotentReplayed' },
          }
        : EVERY_ANSWER,
      ...(schema && {
        content: { 'application/json': { schema: schemaRef(schema), examples } },
      }),
    },
  };
}

type Plane = 'none' | 'server' | 'client';

type Operation = {
  operationId: string;
  tag: string;
  stage: string;
  summary: string;
  description: string;
  plane: Plane;
  parameters?: Json[];
  body?: Json;
  answers: Json;
  refuses: readonly ErrorCode[];
  /** What a code means here, where the plane's own line would mislead (`MINT_REFUSALS`). */
  refusalText?: Partial<Record<ErrorCode, string>>;
};

const SECURITY: Record<Plane, Json[]> = {
  none: [],
  server: [{ serverPlane: [] }],
  client: [{ clientPlane: [] }],
};

function operation(op: Operation): Json {
  // "The path answers `404`" holds for `GET /tickets` too, on the path
  // `POST /tickets` serves from stage 4, only because stage 4's route exports
  // `GET` and answers it that `404` until stage 5: Next answers a method a
  // route file does not export with `405`, which an SDK reads as its own bug
  // (`plans/myblu-ticket-api.md`, stage 4; `openapi.test.ts` names every path
  // whose methods ship apart).
  const served =
    op.stage === '0b'
      ? 'Served from stage 0b.'
      : `Served from stage ${op.stage}. Until that stage ships, the path answers \`404\` with no body of this shape: the shapes are published first so the app and the SDK can be written against them.`;
  const parameters = [
    ...(op.plane === 'client' ? [{ $ref: '#/components/parameters/ShipBluClient' }] : []),
    ...(op.parameters ?? []),
  ];
  return {
    operationId: op.operationId,
    tags: [op.tag],
    summary: op.summary,
    description: `${op.description}\n\n${served}`,
    'x-shipblu-stage': op.stage,
    security: SECURITY[op.plane],
    ...(parameters.length > 0 && { parameters }),
    ...(op.body && { requestBody: op.body }),
    responses: { ...op.answers, ...refusals(op.refuses, op.refusalText) },
  };
}

function jsonBody(schema: string, examples: Record<string, Json>, description?: string): Json {
  return {
    required: true,
    ...(description && { description }),
    content: { 'application/json': { schema: schemaRef(schema), examples } },
  };
}

const MULTIPART_NOTE =
  'JSON, or `multipart/form-data` with the same fields as parts and `files` repeated. Multipart is accepted from the files stage (stage 7); before it, a multipart body is `400 invalid_request`. A multipart body must carry `Content-Length` (`411 length_required` without it).';

function sendBody(json: string, multipart: string, examples: Record<string, Json>): Json {
  return {
    required: true,
    description: MULTIPART_NOTE,
    content: {
      'application/json': { schema: schemaRef(json), examples },
      'multipart/form-data': { schema: schemaRef(multipart) },
    },
  };
}

const ticketPath = { $ref: '#/components/parameters/TicketIdPath' };
const idempotencyKey = { $ref: '#/components/parameters/IdempotencyKey' };

function paths(): Json {
  const sent = (ticket: z.input<typeof Ticket>, message: z.input<typeof Message>) =>
    example(SendResult, 'The message as stored, and its ticket after it', { ticket, message });

  return {
    '/openapi.json': {
      get: operation({
        operationId: 'getContract',
        tag: 'Contract',
        stage: '0b',
        summary: 'This document',
        description:
          'The OpenAPI document of the server answering, built from the schemas its routes parse with. No credential; behind the per-address limit.',
        plane: 'none',
        answers: answer({
          status: 200,
          description: 'This document.',
          schema: 'OpenApiDocument',
          examples: {
            document: example(OpenApiDocument, 'This document, cut short', {
              openapi: '3.1.0',
              info: { title: TITLE, version: CONTRACT_VERSION },
            }),
          },
        }),
        refuses: ['rate_limited', 'internal'],
      }),
    },
    '/sessions': {
      post: operation({
        operationId: 'createSession',
        tag: 'Sessions',
        stage: '3',
        summary: 'Mint a session for one user',
        description:
          "Server plane: myBlu's backend, when its app asks for support, never the app. Mints a new token on every call; the backend hands it to the app and keeps no copy. Twenty-four hours, no refresh: the app asks its backend again.",
        plane: 'server',
        body: jsonBody('CreateSessionRequest', {
          mint: example(CreateSessionRequest, 'A user signed in on iOS', {
            externalUserId: EXTERNAL_ID,
            phone: '+201001234567',
            name: 'Nour Adel',
            client: { platform: 'ios', appVersion: '5.4.1' },
          }),
        }),
        answers: answer({
          status: 201,
          description: 'Minted.',
          schema: 'Session',
          examples: {
            minted: example(Session, 'A new session', {
              token: 'sbu_q3Vt8kM2xY0bN5rJ7wPz1cD4fG6hL9sA2eR5tU8iO0p',
              expiresAt: '2026-11-13T09:29:41.000Z',
              expiresInSeconds: 86_400,
            }),
          },
        }),
        refuses: [...SERVER_PLANE, 'blocked'],
        refusalText: MINT_REFUSALS,
      }),
    },
    '/sessions/revoke': {
      post: operation({
        operationId: 'revokeSessions',
        tag: 'Sessions',
        stage: '3',
        summary: 'End every session of one user',
        description:
          'Server plane. Ends every session of `externalUserId` on every device, and records why. Answers `204` whether or not the user is known, so it cannot be used to ask who is.',
        plane: 'server',
        body: jsonBody('RevokeSessionsRequest', {
          deleted: example(RevokeSessionsRequest, 'The account was deleted', {
            externalUserId: EXTERNAL_ID,
            reason: 'account_deleted',
          }),
        }),
        answers: answer({ status: 204, description: 'Done, or nothing to do.' }),
        refuses: SERVER_PLANE,
        refusalText: REVOKE_REFUSALS,
      }),
    },
    '/session': {
      delete: operation({
        operationId: 'endSession',
        tag: 'Sessions',
        stage: '3',
        summary: 'End this session',
        description:
          "Client plane. Ends the presented token and nothing else: the user's other devices keep theirs. The SDK's `reset()` calls it with a five-second deadline and wipes the device whether or not it landed. The one client-plane call a blocked user is not refused: their session is ended and answered `204` too, since a refusal would leave it live for the rest of its day, and usable again if the block were lifted.",
        plane: 'client',
        answers: answer({ status: 204, description: 'Ended.' }),
        // A blocked user's session is ended, not refused (`endingPlane`).
        refuses: CLIENT_PLANE.filter((code) => code !== 'blocked'),
      }),
    },
    '/config': {
      get: operation({
        operationId: 'getConfig',
        tag: 'Config',
        stage: '3',
        summary: 'Who is signed in, and what the server allows',
        description:
          'Read on start and after every new token. `user.externalId` must be the user the token was asked for, or the client discards the token.',
        plane: 'client',
        answers: answer({
          status: 200,
          description: 'The configuration.',
          schema: 'Config',
          examples: {
            config: example(Config, 'Outside the team’s hours (lists shortened)', {
              user: { id: IDS.identity, externalId: EXTERNAL_ID },
              tickets: { canCreate: true, maxOpen: 10 },
              limits: {
                messageMaxChars: MAX_WIDGET_MESSAGE_CHARS,
                maxFiles: MAX_WIDGET_FILES,
                maxFileBytes: MAX_WIDGET_FILE_BYTES,
                maxTotalBytes: MAX_WIDGET_TOTAL_BYTES,
                contentTypes: [
                  'image/jpeg',
                  'image/png',
                  'image/heic',
                  'application/pdf',
                  'video/mp4',
                  'audio/mp4',
                ],
                extensions: ['jpg', 'jpeg', 'png', 'heic', 'pdf', 'mp4', 'mov', 'm4a'],
              },
              support: {
                online: false,
                opensAt: '2026-11-13T07:00:00.000Z',
                timezone: 'Africa/Cairo',
              },
              polling: { threadSeconds: 5, listSeconds: 30 },
            }),
          },
        }),
        refuses: CLIENT_PLANE,
      }),
    },
    '/tickets': {
      get: operation({
        operationId: 'listTickets',
        tag: 'Tickets',
        stage: '5',
        summary: "The user's tickets",
        description:
          'Newest first, by `(lastMessageAt, id)`, paged back with `before`. Polled by re-reading the first page and merging by `id`, at `pollAfterSeconds`.',
        plane: 'client',
        parameters: queryParameters(ListTicketsQuery),
        answers: answer({
          status: 200,
          description: 'A page of tickets.',
          schema: 'TicketsPage',
          examples: {
            page: example(TicketsPage, 'The first page, at its end', {
              tickets: [TICKET, RESOLVED_TICKET],
              olderCursor: null,
              unreadTotal: 1,
              pollAfterSeconds: 30,
            }),
          },
        }),
        refuses: [...CLIENT_PLANE, 'invalid_cursor'],
      }),
      post: operation({
        operationId: 'createTicket',
        tag: 'Tickets',
        stage: '4',
        summary: 'Open a ticket',
        description:
          'Opens a ticket with its first message. `Idempotency-Key` is required: a retry under the same key answers `200` with `Idempotent-Replayed: true` and what the first attempt stored, and creates nothing. A retry whose ticket the user can no longer read — deleted, marked spam or merged away since the first attempt — is `404 not_found`, and nothing is created.',
        plane: 'client',
        parameters: [idempotencyKey],
        body: sendBody('CreateTicketRequest', 'CreateTicketMultipart', {
          parcel: example(CreateTicketRequest, 'About a parcel', {
            text: OPENING.text,
            locale: 'en',
            trackingNumber: '1755021358719',
          }),
        }),
        answers: {
          ...answer({
            status: 201,
            description: 'Opened.',
            schema: 'SendResult',
            examples: { opened: sent(NEW_TICKET, OPENING) },
          }),
          ...answer({
            status: 200,
            description: 'A retry of a create that already succeeded: what it stored.',
            schema: 'SendResult',
            examples: { replayed: sent(NEW_TICKET, OPENING) },
            replayed: true,
          }),
        },
        refuses: [
          ...CLIENT_PLANE,
          'idempotency_key_required',
          'empty_message',
          'file_refused',
          'not_found',
          'too_many_open',
          'key_reused',
          'length_required',
          'too_large',
          'upload_failed',
        ],
      }),
    },
    '/tickets/{id}': {
      get: operation({
        operationId: 'getTicket',
        tag: 'Tickets',
        stage: '4',
        summary: 'One ticket',
        description: 'One ticket the user opened.',
        plane: 'client',
        parameters: [ticketPath],
        answers: answer({
          status: 200,
          description: 'The ticket.',
          schema: 'TicketEnvelope',
          examples: {
            ticket: example(TicketEnvelope, 'An open ticket with one unread reply', {
              ticket: TICKET,
            }),
          },
        }),
        refuses: [...CLIENT_PLANE, 'not_found'],
      }),
    },
    '/tickets/{id}/messages': {
      get: operation({
        operationId: 'listMessages',
        tag: 'Messages',
        stage: '4',
        summary: "A page of a ticket's messages",
        description:
          'With no cursor, the newest page; `before` pages back, `after` polls forward, never both. Ascending by `(createdAt, id)` either way. `after` re-reads a few seconds before its cursor, because a row stamped earlier can commit later, so a page may repeat rows: merge by `id`. Poll at `pollAfterSeconds`.',
        plane: 'client',
        parameters: [ticketPath, ...queryParameters(ListMessagesQuery)],
        answers: answer({
          status: 200,
          description: 'A page of messages.',
          schema: 'MessagesPage',
          examples: {
            newest: example(MessagesPage, 'The newest page of a short thread', {
              messages: [OPENING, PHOTO, REPLY],
              olderCursor: null,
              newerCursor: cursor('2026-11-12 09:41:07.004213+00', REPLY.id),
              ticket: TICKET,
              unreadTotal: 1,
              pollAfterSeconds: 5,
            }),
          },
        }),
        refuses: [...CLIENT_PLANE, 'invalid_cursor', 'not_found'],
      }),
      post: operation({
        operationId: 'sendMessage',
        tag: 'Messages',
        stage: '4',
        summary: 'Send a message',
        description:
          'Sends a message on a ticket. A reply to a `resolved` ticket reopens it; one to a `closed` ticket is `409 ticket_closed`, and the app offers a new ticket. `Idempotency-Key` is required, as on `POST /tickets`.',
        plane: 'client',
        parameters: [ticketPath, idempotencyKey],
        body: sendBody('SendMessageRequest', 'SendMessageMultipart', {
          answer: example(SendMessageRequest, 'An answer, in Arabic', {
            text: ANSWER.text,
            locale: 'ar',
          }),
        }),
        answers: {
          ...answer({
            status: 201,
            description: 'Sent.',
            schema: 'SendResult',
            examples: { sent: sent(ANSWERED_TICKET, ANSWER) },
          }),
          ...answer({
            status: 200,
            description: 'A retry of a send that already succeeded: what it stored.',
            schema: 'SendResult',
            examples: { replayed: sent(ANSWERED_TICKET, ANSWER) },
            replayed: true,
          }),
        },
        refuses: [
          ...CLIENT_PLANE,
          'idempotency_key_required',
          'empty_message',
          'file_refused',
          'not_found',
          'ticket_closed',
          'key_reused',
          'length_required',
          'too_large',
          'upload_failed',
        ],
      }),
    },
    '/tickets/{id}/read': {
      post: operation({
        operationId: 'markRead',
        tag: 'Tickets',
        stage: '5',
        summary: "Mark the team's messages read",
        description:
          "Marks the team's messages on the ticket read up to `upTo`, which the agent sees as Read. `upTo` is any message this API returned on this ticket; one that is not a reply on it is `400 invalid_request` and marks nothing. Marking twice, or backwards, changes nothing.",
        plane: 'client',
        parameters: [ticketPath],
        body: jsonBody('MarkReadRequest', {
          upTo: example(MarkReadRequest, 'Read up to the agent’s reply', { upTo: REPLY.id }),
        }),
        answers: answer({
          status: 200,
          description: 'Marked.',
          schema: 'ReadResult',
          examples: {
            read: example(ReadResult, 'Nothing left unread', {
              ticket: { ...TICKET, unreadCount: 0 },
              unreadTotal: 0,
            }),
          },
        }),
        refuses: [...CLIENT_PLANE, 'not_found'],
      }),
    },
    '/attachments/{id}': {
      get: operation({
        operationId: 'getAttachmentLink',
        tag: 'Attachments',
        stage: '7',
        summary: 'Where to fetch a file',
        description:
          "A five-minute link to the file's bytes, as JSON rather than a redirect, so no HTTP library has to decide whether to forward the bearer to another host. Use it at once; a `403` from it means ask again.",
        plane: 'client',
        parameters: [{ $ref: '#/components/parameters/AttachmentIdPath' }],
        answers: answer({
          status: 200,
          description: 'The link.',
          schema: 'AttachmentLink',
          examples: {
            link: example(AttachmentLink, 'A photo', {
              url: `https://storage.example.com/attachments/${IDS.attachment}?token=example`,
              expiresInSeconds: 300,
            }),
          },
        }),
        refuses: [...CLIENT_PLANE, 'not_found'],
      }),
    },
    '/tickets/{id}/survey': {
      get: operation({
        operationId: 'getSurvey',
        tag: 'Surveys',
        stage: '8',
        summary: "The ticket's survey",
        description:
          'The satisfaction survey on a resolved ticket, worded on the server in its own locale. `404 not_found` while the ticket has none, and for a survey the team decided not to send.',
        plane: 'client',
        parameters: [ticketPath],
        answers: answer({
          status: 200,
          description: 'The survey.',
          schema: 'SurveyEnvelope',
          examples: {
            survey: example(SurveyEnvelope, 'Waiting for a rating, in Arabic', {
              survey: SURVEY_AR,
            }),
          },
        }),
        refuses: [...CLIENT_PLANE, 'not_found'],
      }),
      post: operation({
        operationId: 'answerSurvey',
        tag: 'Surveys',
        stage: '8',
        summary: 'Answer the survey',
        description:
          'Posted when a rating is tapped; a comment is a second `POST` carrying the same rating. The first rating wins whichever way it came, so draw what this answers.',
        plane: 'client',
        parameters: [ticketPath],
        body: jsonBody('AnswerSurveyRequest', {
          rating: example(AnswerSurveyRequest, 'A rating, tapped', { rating: 4 }),
        }),
        answers: answer({
          status: 200,
          description: 'The survey as it stands afterwards.',
          schema: 'SurveyEnvelope',
          examples: {
            answered: example(SurveyEnvelope, 'Rated 4', {
              survey: { ...SURVEY_AR, status: 'answered', rating: 4 },
            }),
          },
        }),
        refuses: [...CLIENT_PLANE, 'not_found'],
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

const WEBHOOK_HEADERS = [
  { $ref: '#/components/parameters/WebhookEvent' },
  { $ref: '#/components/parameters/WebhookEventId' },
  { $ref: '#/components/parameters/WebhookTimestamp' },
  { $ref: '#/components/parameters/WebhookSignature' },
];

/**
 * One receiver, because myBlu's backend registers one URL
 * (`MYBLU_WEBHOOK_URL`) and every event arrives there, told apart by `type`:
 * so the document publishes the union a receiver parses rather than an entry
 * per event that would suggest a URL per event. Each arm says from which stage
 * it is sent.
 */
function webhooks(): Json {
  const user = { externalId: EXTERNAL_ID };
  return {
    event: {
      post: {
        operationId: 'receiveEvent',
        tags: ['Webhook'],
        summary: "Something happened on one of the user's tickets",
        description:
          "Sent to myBlu's backend, at the one URL it registered, so it can push: `message.created` when a person on the team or an automated reply writes on one of the user's tickets (from stage 6), and `survey.created` when a resolved ticket's survey is ready (from stage 8). Ids only, never text: read the message or the survey through the client plane. A hint, not the truth; the poll is the truth. More types are added; answer `2xx` to one you do not know.\n\nThe URL is `https`, with no query string and no userinfo; one that is not is refused when it is first used, and nothing is sent. It is posted to exactly as registered and a redirect is not followed, so a `3xx` is a failed delivery: register it as the receiver serves it, trailing slash included. Each attempt waits ten seconds for an answer, and one not answered by then is retried as a refusal is. Retries back off and stop within a day of the event, so a day of dedupe on `id` covers them; a receiver down for longer loses those pushes, never the messages, which the app's poll still reads.\n\nThe signature is `X-ShipBlu-Signature`, an HMAC under `MYBLU_WEBHOOK_SECRET`; the guide prints the scheme, the receiver's rules and a test vector.",
        'x-shipblu-stage': '6',
        security: [{ webhookSignature: [] }],
        parameters: WEBHOOK_HEADERS,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: schemaRef('WebhookEvent'),
              examples: {
                'message.created': example(MessageCreatedEvent, "An agent's reply", {
                  version: 1,
                  id: `message.created:${IDS.reply}`,
                  type: 'message.created',
                  occurredAt: REPLY.createdAt,
                  user,
                  ticket: { id: IDS.ticket, number: 4812, status: 'open' },
                  message: { id: IDS.reply, from: 'agent' },
                }),
                'survey.created': example(SurveyCreatedEvent, 'A survey on a resolved ticket', {
                  version: 1,
                  id: `survey.created:${IDS.survey}`,
                  type: 'survey.created',
                  occurredAt: '2026-11-10T08:45:40.200Z',
                  user,
                  ticket: {
                    id: RESOLVED_TICKET.id,
                    number: RESOLVED_TICKET.number,
                    status: 'resolved',
                  },
                  survey: { id: IDS.survey, expiresAt: SURVEY_AR.expiresAt ?? null },
                }),
              },
            },
          },
        },
        responses: {
          '2XX': {
            description:
              'Received. Answer within ten seconds, as soon as the signature is checked and the event recorded, and do the work after: anything else, a redirect included, is retried with backoff, and the same event arrives again.',
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const DESCRIPTION = `The HTTP API the myBlu app reaches support through, and the webhook it is told of replies by. The guide, \`docs/myblu-api.md\` in the shipblu-support repository, says what every field means, what an SDK must do, and the scenarios it is checked with; this document is the shapes.

Two planes. The **server plane** is myBlu's backend, holding \`MYBLU_API_TOKEN\`: it mints and ends sessions and does nothing else. The **client plane** is the app, through the SDK, holding a session token for one user: it does everything else, as that user.

Every client-plane request carries \`ShipBlu-Client\`. Every answer carries \`ShipBlu-Request-Id\` and \`Cache-Control: no-store\`. JSON, UTF-8, ISO-8601 instants in UTC, UUID ids, no credential in a URL and no trailing slash.

**It changes by addition.** Fields and enum values appear without notice, and a client ignores a field it does not know and keeps an enum value it does not know. What an operation sends and answers is fixed from the release that ships it; a breaking change is \`/api/v2\`. Each change is a dated line in \`docs/myblu-api-changelog.md\`, whose newest date is \`info.version\`.`;

function document(): Json {
  return {
    openapi: '3.1.0',
    info: {
      title: TITLE,
      version: CONTRACT_VERSION,
      description: DESCRIPTION,
    },
    servers: [
      {
        url: 'https://support.shipblu.com/api/v1',
        description:
          'Production, on the name meant to last. Kept in the app’s build configuration.',
      },
      {
        url: 'https://shipblu-support.onrender.com/api/v1',
        description: 'Production, on its service host: the same server.',
      },
      {
        url: 'https://shipblu-support-staging.onrender.com/api/v1',
        description:
          'Staging: suspended, and resumed for named test windows with its own secrets. Never point a staging app at production.',
      },
      {
        url: 'http://127.0.0.1:4010',
        description: 'A mock served from this document on a developer’s machine (see the guide).',
      },
    ],
    tags: [
      { name: 'Contract', description: 'This document.' },
      { name: 'Sessions', description: 'Minting and ending sessions.' },
      { name: 'Config', description: 'Who is signed in, and what the server allows.' },
      { name: 'Tickets', description: 'The user’s tickets: one per problem, many per user.' },
      { name: 'Messages', description: 'What the user and the team wrote on a ticket.' },
      { name: 'Attachments', description: 'Files on messages.' },
      { name: 'Surveys', description: 'The satisfaction survey on a resolved ticket.' },
      { name: 'Webhook', description: 'What this server sends to myBlu’s backend.' },
    ],
    paths: paths(),
    webhooks: webhooks(),
    components: {
      schemas: componentSchemas(),
      securitySchemes: {
        serverPlane: {
          type: 'http',
          scheme: 'bearer',
          description:
            "`MYBLU_API_TOKEN`, held by myBlu's backend and never shipped in an app: a value compiled into a binary is extractable, and whoever extracts it can mint any user. It mints and ends sessions; nothing else accepts it.",
        },
        clientPlane: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'sbu_…',
          description:
            "A session token for one user, minted by the server plane and handed to the app by myBlu's backend. Twenty-four hours from minting, with no refresh: on any `401` the SDK asks for a new one once and replays once.",
        },
        // Not a credential the receiver holds and sends, but the check it
        // makes: stated as a scheme so a reader of the webhook sees that it is
        // authenticated, and how.
        webhookSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-ShipBlu-Signature',
          description:
            '`v1=` and the hex HMAC-SHA256, under `MYBLU_WEBHOOK_SECRET`, of `<X-ShipBlu-Timestamp>.<raw body>`. Verify over the raw bytes, before parsing; refuse a timestamp more than five minutes off.',
        },
      },
      parameters: {
        ShipBluClient: parameter(
          'ShipBlu-Client',
          'header',
          ShipBluClientHeader,
          true,
          'sdk-ts/0.3.0 app/5.4.1 ios/18.1',
        ),
        IdempotencyKey: parameter(
          'Idempotency-Key',
          'header',
          IdempotencyKeyHeader,
          true,
          IDS.openingKey,
        ),
        TicketIdPath: parameter('id', 'path', TicketId, true, IDS.ticket),
        AttachmentIdPath: parameter('id', 'path', AttachmentId, true, IDS.attachment),
        // By reference, so the open list is stated once, with its description.
        WebhookEvent: {
          name: 'X-ShipBlu-Event',
          in: 'header',
          required: true,
          description: "The body's `type`, so a receiver can route before it parses.",
          schema: schemaRef('WebhookEventType'),
          example: 'message.created',
        },
        WebhookEventId: parameter(
          'X-ShipBlu-Event-Id',
          'header',
          WebhookEventIdHeader,
          true,
          `message.created:${IDS.reply}`,
        ),
        // The guide's test vector: this timestamp and this signature are the
        // `message.created` example's body signed under its throwaway secret, and
        // `openapi.test.ts` holds the three together.
        WebhookTimestamp: parameter(
          'X-ShipBlu-Timestamp',
          'header',
          WebhookTimestampHeader,
          true,
          '1794476469',
        ),
        WebhookSignature: parameter(
          'X-ShipBlu-Signature',
          'header',
          WebhookSignatureHeader,
          true,
          'v1=3124322b87a59bb4b8b2677d6ff364ea2b77f48be9d0933de71ff3be1433f03d',
        ),
      },
      headers: {
        RequestId: header(RequestIdHeader, IDS.request),
        CacheControl: header(CacheControlHeader, 'no-store'),
        IdempotentReplayed: header(IdempotentReplayedHeader, 'true'),
        RetryAfter: header(RetryAfterHeader, 7),
      },
      examples: Object.fromEntries(ErrorCode.options.map((code) => [code, refusalExample(code)])),
    },
  };
}

let built: Json | undefined;
let serialised: string | undefined;

/**
 * The document, built once per process on first use. Lazily, never at module
 * scope: `next build` imports the route that serves it, and a build should not
 * pay for a document nobody asked for.
 */
export function openApiDocument(): Json {
  built ??= document();
  return built;
}

/**
 * The document as the route sends it, serialised once beside the object. It
 * is some 120 kilobytes of JSON and the same on every request until the next
 * deploy, so stringifying it per request spent an instance's CPU on a route
 * whose only limit is the address bucket's 1,200 a minute.
 */
export function openApiDocumentJson(): string {
  serialised ??= JSON.stringify(openApiDocument());
  return serialised;
}
