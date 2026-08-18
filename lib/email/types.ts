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
  /** Provider's id for the accepted message, when it returns one. */
  providerMessageId: string | null;
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

  /**
   * Asynchronous verification, for providers that cannot answer synchronously.
   *
   * SES signs through SNS with RSA over a canonical string, and checking it
   * needs the signing certificate fetched over the network. When present this
   * is used instead of `verifySignature`.
   */
  verifyWebhook?(rawBody: string, headers: Record<string, string>): Promise<boolean>;

  /**
   * Handle a provider control message — an SNS subscription confirmation, for
   * example — that carries no email. Returning true means the payload is fully
   * dealt with and must not be queued for ingestion.
   */
  handleControlMessage?(payload: unknown, headers: Record<string, string>): Promise<boolean>;

  parseInbound(payload: unknown): Promise<ParsedInboundEmail>;
}
