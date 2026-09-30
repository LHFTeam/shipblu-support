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
   * be `receivedAt`, and it is wrong in both directions: a clock two hours slow
   * filed the customer's answer above the reply it answered and hid it from the
   * inbox card; one twelve hours fast held the ticket at the top of the list.
   */
  dateHeader: Date | null;

  /**
   * When the delivery reached us: `webhook_events.received_at`, stamped by our
   * endpoint as it stored the payload.
   *
   * Every clock downstream reads this — `messages.created_at`, the list's
   * `last_message_at`, `last_customer_message_at` and the next-response SLA —
   * because it is the first moment the team could have seen the mail, which is
   * what a support timeline orders by and what an SLA can fairly charge from.
   * Taken from the stored row rather than the worker's clock so that a
   * delivery processed late, or replayed by hand, keeps the instant it arrived.
   * Postmark retrying an endpoint that was down makes it later than the mail
   * was, by up to the ten or so hours those retries last, and that delay is
   * ours.
   */
  receivedAt: Date;
};

/**
 * What a provider can read off a delivery: everything except when it arrived.
 *
 * `receivedAt` is left out of the type rather than documented as "do not fill
 * this from the payload", so a driver cannot reach for the mail's `Date` header
 * again without the return type refusing it. The worker adds the instant from
 * the stored delivery (`worker/handlers/process-webhook.ts`).
 */
export type ProviderInboundEmail = Omit<ParsedInboundEmail, 'receivedAt'>;

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

  parseInbound(payload: unknown): Promise<ProviderInboundEmail>;
}
