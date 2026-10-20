/**
 * Packing the extension as Chrome installs it from outside the Web Store: a
 * CRX3 file, which is a signed header in front of an ordinary zip.
 *
 * Written out rather than taken from a package because it is small, it is
 * security-relevant, and every byte of it can be checked: the format is
 * Chromium's own (`components/crx_file/crx3.proto`), the zip is the plainest
 * the spec allows, and the test beside this file verifies the signature with
 * Node's crypto and reads every entry back. What proves it end to end is
 * Chrome itself refusing to install a CRX whose signature or id is wrong —
 * `extension/README.md` describes that check.
 *
 * Plain JavaScript, because `build.mjs` and `pack.mjs` run under bare `node`.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A zip of `entries`, deflated where that helps, with every timestamp fixed at
 * the zip epoch (1980-01-01) so the same files always make the same bytes.
 *
 * @param {{ name: string; data: Buffer }[]} entries
 * @returns {Buffer}
 */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // 00:00
    local.writeUInt16LE(DOS_EPOCH_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // no extra field

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4); // made by: 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_EPOCH_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // Extra field, comment, disk number, attributes: all zero.
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/** 1980-01-01 in MS-DOS date format: (year - 1980) << 9 | month << 5 | day. */
const DOS_EPOCH_DATE = (1 << 5) | 1;

/**
 * The CRX3 file for `zipBytes`, signed with an RSA private key in PEM.
 *
 * The extension's id is the key's: the first 16 bytes of the SHA-256 of its
 * public half. So the key *is* the extension's identity — the policy on every
 * laptop names that id, and a package signed with another key is a different
 * extension Chrome will not take as an update. Losing it means reinstalling
 * everywhere; leaking it means anyone can sign an update the laptops accept
 * from the update URL.
 *
 * @param {Buffer} zipBytes
 * @param {string} privateKeyPem
 * @returns {{ crx: Buffer; id: string }}
 */
export function crx3(zipBytes, privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error(`the extension signing key must be RSA, not ${privateKey.asymmetricKeyType}`);
  }
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const crxId = createHash('sha256').update(publicKey).digest().subarray(0, 16);

  // SignedData { bytes crx_id = 1; }
  const signedHeaderData = field(1, crxId);

  // What is signed: a fixed preamble, the signed header data with its length,
  // then the archive — so the signature covers both the id and every file.
  const signature = sign(
    'sha256',
    Buffer.concat([
      Buffer.from('CRX3 SignedData\x00', 'latin1'),
      uint32(signedHeaderData.length),
      signedHeaderData,
      zipBytes,
    ]),
    privateKey,
  );

  // CrxFileHeader {
  //   repeated AsymmetricKeyProof sha256_with_rsa = 2;
  //   bytes signed_header_data = 10000;
  // }
  // AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
  const header = Buffer.concat([
    field(2, Buffer.concat([field(1, publicKey), field(2, signature)])),
    field(10000, signedHeaderData),
  ]);

  return {
    crx: Buffer.concat([
      Buffer.from('Cr24', 'latin1'),
      uint32(3),
      uint32(header.length),
      header,
      zipBytes,
    ]),
    id: extensionId(crxId),
  };
}

/** Chrome's spelling of an id: each hex digit of the 16 bytes as `a`–`p`. */
function extensionId(crxId) {
  return [...crxId.toString('hex')]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join('');
}

/** A length-delimited protobuf field (wire type 2). */
function field(number, bytes) {
  return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
}

function varint(value) {
  const bytes = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
}
