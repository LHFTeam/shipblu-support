import { randomBytes } from 'node:crypto';
import type { EmailAddress, OutboundEmail } from './types';

/**
 * Builds an RFC 5322 message.
 *
 * Hand-rolled because SES's simple send API cannot set `In-Reply-To`,
 * `References` or a custom `Message-ID`, and those three headers are what makes
 * a reply thread in Gmail and Outlook instead of starting a new conversation.
 * Raw sending is the only way to control them, and a raw send needs a MIME
 * document.
 *
 * Everything is encoded conservatively: headers as RFC 2047 when they are not
 * plain ASCII, bodies as base64. Quoted-printable would be smaller but has a
 * long tail of line-length and trailing-whitespace rules that go wrong quietly,
 * and base64 has none of them.
 */

const CRLF = '\r\n';

export function buildRawMessage(email: OutboundEmail): Buffer {
  const boundaryAlt = `alt_${randomBytes(12).toString('hex')}`;
  const boundaryMixed = `mix_${randomBytes(12).toString('hex')}`;

  const hasAttachments = (email.attachments?.length ?? 0) > 0;

  const headers: string[] = [
    `From: ${formatAddress(email.from)}`,
    `To: ${email.to.map(formatAddress).join(', ')}`,
  ];

  if (email.cc?.length) headers.push(`Cc: ${email.cc.map(formatAddress).join(', ')}`);
  if (email.bcc?.length) headers.push(`Bcc: ${email.bcc.map(formatAddress).join(', ')}`);

  headers.push(`Reply-To: ${email.replyTo}`);
  headers.push(`Subject: ${encodeHeaderValue(email.subject)}`);
  headers.push(`Message-ID: <${email.messageId}>`);

  if (email.inReplyTo) headers.push(`In-Reply-To: <${email.inReplyTo}>`);
  if (email.references?.length) {
    // Folded at 78 characters: a long References chain on one line is refused
    // by some strict receivers, and RFC 5322 has a hard 998-character limit.
    headers.push(foldHeader('References', email.references.map((id) => `<${id}>`).join(' ')));
  }

  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push('MIME-Version: 1.0');

  for (const [name, value] of Object.entries(email.headers ?? {})) {
    headers.push(`${name}: ${encodeHeaderValue(value)}`);
  }

  const alternative = [
    `--${boundaryAlt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(email.textBody),
    `--${boundaryAlt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(email.htmlBody),
    `--${boundaryAlt}--`,
  ].join(CRLF);

  if (!hasAttachments) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundaryAlt}"`);
    return Buffer.from(`${headers.join(CRLF)}${CRLF}${CRLF}${alternative}${CRLF}`, 'utf8');
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundaryMixed}"`);

  const parts = [
    `--${boundaryMixed}`,
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    '',
    alternative,
  ];

  for (const attachment of email.attachments ?? []) {
    parts.push(
      `--${boundaryMixed}`,
      `Content-Type: ${attachment.contentType}; name="${sanitiseFilename(attachment.filename)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${sanitiseFilename(attachment.filename)}"`,
      '',
      wrap(attachment.content.toString('base64')),
    );
  }

  parts.push(`--${boundaryMixed}--`);

  return Buffer.from(`${headers.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}${CRLF}`, 'utf8');
}

export function formatAddress(address: EmailAddress): string {
  if (!address.name) return address.address;
  return `${encodeHeaderValue(address.name, true)} <${address.address}>`;
}

/**
 * RFC 2047 encoding, applied only when needed.
 *
 * Agent names and subjects are routinely Arabic here, and an unencoded
 * non-ASCII header is either mangled or rejected outright.
 */
export function encodeHeaderValue(value: string, quoteIfPlain = false): string {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();

  if (!/[^\x20-\x7E]/.test(clean)) {
    return quoteIfPlain && /[",;:<>@[\]\\]/.test(clean) ? `"${clean.replace(/"/g, '\\"')}"` : clean;
  }

  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/** Folds a long header across continuation lines at whitespace. */
function foldHeader(name: string, value: string): string {
  const limit = 78;
  let line = `${name}:`;
  const lines: string[] = [];

  for (const token of value.split(' ')) {
    if (line.length + token.length + 1 > limit) {
      lines.push(line);
      line = ` ${token}`;
    } else {
      line += ` ${token}`;
    }
  }
  lines.push(line);

  return lines.join(CRLF);
}

function base64Body(body: string): string {
  return wrap(Buffer.from(body, 'utf8').toString('base64'));
}

/** RFC 2045 caps encoded lines at 76 characters. */
function wrap(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join(CRLF);
}

/**
 * Filenames reach us from agents and from forwarded customer attachments, so a
 * quote or a newline in one would otherwise break out of the header.
 */
function sanitiseFilename(filename: string): string {
  return filename.replace(/[\r\n"\\]/g, '_').slice(0, 200) || 'attachment';
}
