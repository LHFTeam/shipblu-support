/**
 * Provider-agnostic email contract.
 *
 * Everything above this interface (threading, ingestion, ticket creation) is
 * written against these types, so switching vendor means adding one file in
 * `providers/` and changing EMAIL_PROVIDER — no changes to the pipeline.
 */

export type EmailAddress = {
  address: string;
  name?: string;
};

export type InboundAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
  /** Set for inline images referenced from the HTML body by `cid:`. */
  contentId?: string;
  isInline: boolean;
};

export type ParsedInboundEmail = {
  /** RFC 5322 Message-ID, angle brackets stripped. */
  messageId: string;
  inReplyTo?: string;
  /** Oldest → newest, angle brackets stripped. */
  references: string[];

  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  /**
   * Envelope recipient. Some providers deliver the plus-addressed original here
   * even when the To header shows a bare address, so threading checks it too.
   */
  deliveredTo?: string[];

  subject: string;
  textBody: string;
  htmlBody?: string;

  attachments: InboundAttachment[];

  /** Lowercased header names → value, for loop detection and diagnostics. */
  headers: Record<string, string>;

  /** Provider's verdict; null when the provider does not report it. */
  spamScore?: number | null;
  spfPass?: boolean | null;
  dkimPass?: boolean | null;

  /**
   * The mail's own `Date` header, or null when it is missing or does not parse.
   *
   * A claim made by the sender's machine, not a measurement, so it is recorded
   * on the message as evidence and nothing orders or measures by it. It used to
   * be the message's time, and it is wrong in both directions: a clock two hours
   * slow filed the customer's answer above the reply it answered and hid it from
   * the inbox card; one twelve hours fast held the ticket at the top of the list.
   */
  dateHeader: Date | null;
};

/**
 * What the pipeline knows about a delivery that the mail itself cannot say.
 *
 * A separate argument to the two ingest paths rather than a field on
 * `ParsedInboundEmail`, so nothing a provider returns can carry it. A driver
 * that read the `Date` header into it again would have no field to put it in,
 * and no spread order at a call site decides which of two values wins.
 */
export type InboundDelivery = {
  /**
   * When the delivery reached our endpoint: `webhook_events.received_at`,
   * stamped as the payload was stored.
   *
   * Every clock an inbound email sets reads this: a new ticket's `created_at`,
   * and with it the first-response and resolution targets; the message's
   * `created_at`; `last_message_at`, `last_customer_message_at` and the
   * next-response target. It is taken from the stored row rather than the
   * worker's clock, so a delivery processed late or replayed by hand keeps the
   * instant it arrived. Postmark retrying an endpoint that was down makes it
   * later than the mail was, by up to the ten or so hours those retries last,
   * and that delay is ours.
   *
   * It is when the mail reached us, not when anybody could read it. A worker
   * backlog sits between the two, and an agent who writes during one files a
   * message after an answer they have not seen. `last_agent_message_at` is then
   * the later of the two, so every "awaiting us" predicate reads the ticket as
   * answered (docs/PROJECT-STATE.md §6.77). Any arrival instant has that
   * property. The header, seconds earlier still, had it too.
   */
  receivedAt: Date;
};

export type OutboundEmail = {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  from: EmailAddress;
  /** Plus-addressed token so the customer's reply threads back automatically. */
  replyTo: string;

  subject: string;
  textBody: string;
  htmlBody: string;

  /** We generate this so the sent row can be matched to later replies. */
  messageId: string;
  inReplyTo?: string;
  references?: string[];

  attachments?: {
    filename: string;
    contentType: string;
    content: Buffer;
  }[];

  /** Extra headers, e.g. Auto-Submitted on automated sends. */
  headers?: Record<string, string>;
};

export type SendResult = {
  /**
   * The provider's own id for the accepted message — a Postmark UUID, an SES
   * message id. Useful for looking the send up in their dashboard, and nothing
   * else: it is not an RFC 5322 Message-ID and will never appear in a reply's
   * In-Reply-To.
   */
  providerMessageId: string | null;

  /**
   * The Message-ID header the recipient will actually see, when the provider
   * replaces the one we set. Null means ours survived.
   *
   * These are two different things and conflating them silently breaks
   * threading: storing a Postmark UUID as the message's channel id would leave
   * the References lookup matching against an id no mail client has ever seen.
   */
  rfcMessageId?: string | null;

  accepted: boolean;
};

/** Whether an inbound delivery authenticated, and if not, why not. */
export type InboundVerdict = { verified: true } | { verified: false; reason: string };

export interface EmailProvider {
  readonly name: string;

  send(email: OutboundEmail): Promise<SendResult>;

  /**
   * Verify the webhook came from the provider. A refused payload is still stored
   * (for forensics) but never processed into a ticket, and the reason is stored
   * with it: a missing secret and a forged request both arrive as an unverified
   * row, and only the reason tells them apart once the log line has aged out.
   */
  verifySignature(rawBody: string, headers: Record<string, string>): InboundVerdict;

  parseInbound(payload: unknown): Promise<ParsedInboundEmail>;
}
