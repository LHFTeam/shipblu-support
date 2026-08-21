import { describe, expect, it } from 'vitest';
import { locationFromRawBody } from './backfill-message-locations';

/**
 * The contract this backfill depends on: `raw_body` holds the WhatsApp payload
 * as `JSON.stringify` left it, with the pin still inside it. Verified against
 * the archive — every one of the 821 location messages there has this shape —
 * and locked here so that changing what `raw_body` stores fails a test rather
 * than quietly emptying the backfill.
 */
describe('locationFromRawBody', () => {
  it('reads a bare pin out of a stored payload', () => {
    // A real row's shape, coordinates and all.
    const rawBody = JSON.stringify({
      id: 'wamid.HBgLMjAxMTExMTExMTEx',
      from: '201111111111',
      timestamp: '1755600000',
      type: 'location',
      location: { latitude: 29.988094329834, longitude: 31.282814025879 },
    });

    expect(locationFromRawBody(rawBody)).toEqual({
      latitude: 29.988094329834,
      longitude: 31.282814025879,
      name: null,
      address: null,
    });
  });

  it('keeps the place name and address when the payload carries them', () => {
    const rawBody = JSON.stringify({
      type: 'location',
      location: {
        latitude: 26.566639495368,
        longitude: 31.687916368246,
        name: 'HM8Q+P64',
        address: 'El-Khouly, Sohag 1, Sohag Governorate 1681044, Egypt',
      },
    });

    expect(locationFromRawBody(rawBody)).toMatchObject({
      name: 'HM8Q+P64',
      address: 'El-Khouly, Sohag 1, Sohag Governorate 1681044, Egypt',
    });
  });

  it('skips a payload with no pin in it', () => {
    // Reached because the SQL prefilter matches the word "location" anywhere in
    // the blob, so a contact card or a template mentioning it lands here too.
    expect(
      locationFromRawBody(JSON.stringify({ type: 'text', text: { body: 'location?' } })),
    ).toBeNull();
    expect(locationFromRawBody(JSON.stringify({ type: 'location' }))).toBeNull();
    expect(locationFromRawBody(JSON.stringify({ location: 'Cairo' }))).toBeNull();
  });

  it('skips an unusable coordinate rather than storing it', () => {
    expect(
      locationFromRawBody(JSON.stringify({ location: { latitude: 999, longitude: 31 } })),
    ).toBeNull();
    expect(
      locationFromRawBody(JSON.stringify({ location: { latitude: null, longitude: 31 } })),
    ).toBeNull();
  });

  it('never throws on a row it cannot parse', () => {
    // A throw here would fail the whole run over one bad row.
    expect(locationFromRawBody(null)).toBeNull();
    expect(locationFromRawBody('')).toBeNull();
    expect(locationFromRawBody('not json at all')).toBeNull();
    expect(locationFromRawBody('[1,2,3]')).toBeNull();
    expect(locationFromRawBody('null')).toBeNull();
  });
});
