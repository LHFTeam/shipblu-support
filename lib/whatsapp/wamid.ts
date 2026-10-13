/**
 * What a WhatsApp message id identifies, independent of whose copy it names.
 *
 * A wamid is not opaque, and the one place that matters is a coexistence
 * number. It is `wamid.` and the base64 of a Thrift compact-protocol struct —
 * WhatsApp's own message key:
 *
 *   1: chat    struct { 1: user (string), 2: server (i32) }
 *   2: fromMe  bool    — from the business's side
 *   3: id      string  — the message's own id
 *
 * The chat half is whose copy the wamid names, and the same message is named
 * from more than one. A reply the business types on the phone comes back to us
 * as an `smb_message_echoes` delivery keyed on one chat (`EG.<digits>`, server
 * 10), and a customer reacting to that reply names it keyed on their phone
 * number (server 1). Same message, same `fromMe`, same id; two different
 * wamids. Compared as strings, not one of the sixteen customer reactions on a
 * coexistence number in production found the reply it was about, while every
 * one did by key (`docs/PROJECT-STATE.md` §6.94).
 *
 * So the key is `fromMe` and the id. The chat is dropped because it is the part
 * that varies; `fromMe` is kept because the two sides draw ids from separate
 * generators, and the pair is what WhatsApp itself treats as unique within a
 * chat. Anything that does not decode to that shape — a format change, a test
 * double, a non-wamid — answers null, and a caller compares the strings whole.
 */
export function wamidKey(wamid: string): string | null {
  if (!wamid.startsWith(PREFIX)) return null;

  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(wamid.slice(PREFIX.length), 'base64');
  } catch {
    return null;
  }

  const reader = new CompactReader(bytes);
  let fromMe: boolean | null = null;
  let id: string | null = null;

  try {
    reader.readStruct((field, type) => {
      if (field === 2 && (type === BOOL_TRUE || type === BOOL_FALSE)) {
        fromMe = type === BOOL_TRUE;
        return true;
      }
      if (field === 3 && type === BINARY) {
        id = reader.readString();
        return true;
      }
      return false;
    });
  } catch {
    return null;
  }

  // Both or nothing: an id without its side could match the other party's
  // message, and a side without an id matches nothing in particular.
  if (fromMe === null || !id) return null;
  return `${fromMe ? 'out' : 'in'}:${id}`;
}

const PREFIX = 'wamid.';

// Thrift compact-protocol field types; the ones a wamid uses, and the scalars
// a reader has to be able to step over if one ever appears.
const BOOL_TRUE = 1;
const BOOL_FALSE = 2;
const BYTE = 3;
const I16 = 4;
const I32 = 5;
const I64 = 6;
const DOUBLE = 7;
const BINARY = 8;
const STRUCT = 12;

/**
 * Just enough of the compact protocol to walk a struct of scalars, strings and
 * nested structs. A list, set or map throws — no wamid has carried one, and a
 * reader guessing at a shape it does not know would hand back a key that
 * matches the wrong message rather than none.
 */
class CompactReader {
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  /**
   * Calls `visit` for each field; a visitor that does not consume the value
   * returns false and it is skipped.
   */
  readStruct(visit: (field: number, type: number) => boolean): void {
    let field = 0;
    for (;;) {
      const header = this.byte();
      if (header === 0) return;

      const type = header & 0x0f;
      const delta = header >> 4;
      field = delta === 0 ? zigzag(this.varint()) : field + delta;

      if (!visit(field, type)) this.skip(type);
    }
  }

  readString(): string {
    const length = this.varint();
    if (this.at + length > this.bytes.length) throw new RangeError('wamid string overruns');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      this.bytes.subarray(this.at, this.at + length),
    );
    this.at += length;
    return text;
  }

  private skip(type: number): void {
    switch (type) {
      case BOOL_TRUE:
      case BOOL_FALSE:
        return;
      case BYTE:
        this.byte();
        return;
      case I16:
      case I32:
        this.varint();
        return;
      case I64:
        this.varint(10);
        return;
      case DOUBLE:
        this.advance(8);
        return;
      case BINARY:
        this.advance(this.varint());
        return;
      case STRUCT:
        this.readStruct(() => false);
        return;
      default:
        throw new TypeError(`wamid field of compact type ${type}`);
    }
  }

  private byte(): number {
    const value = this.bytes[this.at];
    if (value === undefined) throw new RangeError('wamid ends early');
    this.at += 1;
    return value;
  }

  private advance(length: number): void {
    if (this.at + length > this.bytes.length) throw new RangeError('wamid ends early');
    this.at += length;
  }

  /**
   * An unsigned LEB128 varint. Five bytes covers an i32 and any length a wamid
   * could carry; an i64 is only ever stepped over, so its value is not kept
   * exact.
   */
  private varint(maxBytes = 5): number {
    let value = 0;
    for (let shift = 0; shift < maxBytes * 7; shift += 7) {
      const byte = this.byte();
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new RangeError('wamid varint too long');
  }
}

function zigzag(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}
