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

export interface EmailProvider {
  readonly name: string;

  send(email: OutboundEmail): Promise<SendResult>;

  /**
   * Verify the webhook came from the provider. Returning false means the payload
   * is still stored (for forensics) but never processed into a ticket.
   */
  verifySignature(rawBody: string, headers: Record<string, string>): boolean;

  parseInbound(payload: unknown): Promise<ParsedInboundEmail>;
}
