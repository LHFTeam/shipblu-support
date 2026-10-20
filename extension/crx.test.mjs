import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crx3, zip } from './crx.mjs';

/**
 * The package format, read back with nothing but Node: every zip entry
 * inflated and checked against its CRC, and the CRX signature verified with
 * the public key the header carries. Chrome is the final judge — it refuses a
 * package whose signature or id is wrong — but a mistake here would otherwise
 * surface only as a laptop that silently never installs the extension.
 */

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const ENTRIES = [
  { name: 'manifest.json', data: Buffer.from('{"manifest_version":3,"name":"t","version":"1"}') },
  { name: 'panel.js', data: Buffer.from('console.log("hello");\n'.repeat(200)) },
  { name: 'icons/16.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
];

/** Every entry of a zip, read by walking its local headers. */
function unzip(bytes) {
  const out = [];
  let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const method = bytes.readUInt16LE(at + 8);
    const crc = bytes.readUInt32LE(at + 14);
    const compressed = bytes.readUInt32LE(at + 18);
    const nameLength = bytes.readUInt16LE(at + 26);
    const extraLength = bytes.readUInt16LE(at + 28);
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extraLength;
    const body = bytes.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    out.push({ name, data, crcMatches: crc32(data) === crc });
    at = start + compressed;
  }
  return { entries: out, directoryAt: at };
}

/** The length-delimited fields of one protobuf message, by field number. */
function fields(bytes) {
  const out = new Map();
  let at = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
  };
  while (at < bytes.length) {
    const tag = varint();
    expect(tag & 7).toBe(2);
    const length = varint();
    out.set(tag >>> 3, bytes.subarray(at, at + length));
    at += length;
  }
  return out;
}

describe('zip', () => {
  it('holds every file, each one intact', () => {
    const { entries, directoryAt } = unzip(zip(ENTRIES));

    expect(entries.map((entry) => entry.name)).toEqual(ENTRIES.map((entry) => entry.name));
    entries.forEach((entry, index) => {
      expect(entry.crcMatches).toBe(true);
      expect(entry.data.equals(ENTRIES[index].data)).toBe(true);
    });
    expect(zip(ENTRIES).readUInt32LE(directoryAt)).toBe(0x02014b50);
  });

  it('makes the same bytes from the same files', () => {
    expect(zip(ENTRIES).equals(zip(ENTRIES))).toBe(true);
  });
});

describe('crx3', () => {
  const archive = zip(ENTRIES);
  const { crx, id } = crx3(archive, PEM);

  const headerLength = crx.readUInt32LE(8);
  const header = fields(crx.subarray(12, 12 + headerLength));
  const proof = fields(header.get(2));
  const signedHeaderData = header.get(10000);

  it('is a version 3 CRX with the archive after its header', () => {
    expect(crx.subarray(0, 4).toString('latin1')).toBe('Cr24');
    expect(crx.readUInt32LE(4)).toBe(3);
    expect(crx.subarray(12 + headerLength).equals(archive)).toBe(true);
  });

  it('carries a signature the header’s own public key verifies, over the id and the archive', () => {
    const signed = Buffer.concat([
      Buffer.from('CRX3 SignedData\x00', 'latin1'),
      Buffer.from(Uint32Array.of(signedHeaderData.length).buffer),
      signedHeaderData,
      archive,
    ]);
    const publicKey = createPublicKey({ key: proof.get(1), format: 'der', type: 'spki' });

    expect(verify('sha256', signed, publicKey, proof.get(2))).toBe(true);
    // One flipped byte in the archive and the same signature no longer holds.
    const tampered = Buffer.from(signed);
    tampered[tampered.length - 30] ^= 1;
    expect(verify('sha256', tampered, publicKey, proof.get(2))).toBe(false);
  });

  it('names the extension by its key, in Chrome’s a–p spelling', () => {
    const crxId = fields(signedHeaderData).get(1);
    const expected = createHash('sha256').update(proof.get(1)).digest().subarray(0, 16);

    expect(crxId.equals(expected)).toBe(true);
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(id).toBe(
      [...expected.toString('hex')].map((d) => String.fromCharCode(97 + parseInt(d, 16))).join(''),
    );
  });

  it('refuses a key that is not RSA', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    expect(() => crx3(archive, ec.export({ type: 'pkcs8', format: 'pem' }))).toThrow(/RSA/);
  });
});
