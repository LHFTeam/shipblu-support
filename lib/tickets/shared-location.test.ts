import { describe, expect, it } from 'vitest';
import { formatCoordinates, mapUrl, parseCoordinates, readSharedLocation } from './shared-location';

describe('parseCoordinates', () => {
  it('accepts a pin in Egypt', () => {
    expect(parseCoordinates(30.0444, 31.2357)).toEqual({ latitude: 30.0444, longitude: 31.2357 });
  });

  it('accepts numeric strings, because only one of the two sources is typed', () => {
    // Meta's field is a number, but this also reads a jsonb blob written by an
    // earlier version of the code or by hand at a psql prompt.
    expect(parseCoordinates('30.0444', '31.2357')).toEqual({
      latitude: 30.0444,
      longitude: 31.2357,
    });
  });

  it('accepts the extremes and the origin', () => {
    expect(parseCoordinates(-90, -180)).toEqual({ latitude: -90, longitude: -180 });
    expect(parseCoordinates(90, 180)).toEqual({ latitude: 90, longitude: 180 });
    // 0,0 is a real coordinate. Rejecting it would be inventing a rule about
    // what a customer is allowed to send.
    expect(parseCoordinates(0, 0)).toEqual({ latitude: 0, longitude: 0 });
  });

  it('rejects an out-of-range pair rather than clamping it', () => {
    // The whole point: a clamped or wrapped coordinate still opens a map, still
    // shows somewhere real, and is wrong — the failure nobody goes looking for.
    expect(parseCoordinates(91, 31)).toBeNull();
    expect(parseCoordinates(-90.001, 31)).toBeNull();
    expect(parseCoordinates(30, 180.5)).toBeNull();
    expect(parseCoordinates(30, -181)).toBeNull();
  });

  it('rejects everything that is not a finite number', () => {
    for (const bad of [null, undefined, '', '  ', 'thirty', {}, [], true, NaN, Infinity]) {
      expect(parseCoordinates(bad, 31)).toBeNull();
      expect(parseCoordinates(30, bad)).toBeNull();
    }
  });

  it('rejects a blank string rather than reading it as zero', () => {
    // Number('') is 0, which would silently put the Gulf of Guinea on every
    // message that arrived with an empty field.
    expect(parseCoordinates('', '')).toBeNull();
  });
});

describe('readSharedLocation', () => {
  const location = { latitude: 30.0444, longitude: 31.2357, name: 'Hub', address: 'Cairo' };

  it('reads a stored pin', () => {
    expect(readSharedLocation({ location })).toEqual(location);
  });

  it('keeps the other meta keys out of it', () => {
    expect(readSharedLocation({ whatsappType: 'location', media: {}, location })).toEqual(location);
  });

  it('returns null for a message with no pin', () => {
    expect(readSharedLocation({ whatsappType: 'text' })).toBeNull();
    expect(readSharedLocation({})).toBeNull();
    expect(readSharedLocation(null)).toBeNull();
    expect(readSharedLocation(undefined)).toBeNull();
    expect(readSharedLocation('nonsense')).toBeNull();
  });

  it('is a trust boundary, not a cast', () => {
    // jsonb holds whatever anything ever wrote there, so a shape that does not
    // validate must read as absent rather than reaching the renderer.
    expect(readSharedLocation({ location: { latitude: 'north', longitude: 31 } })).toBeNull();
    expect(readSharedLocation({ location: { latitude: 999, longitude: 31 } })).toBeNull();
    expect(readSharedLocation({ location: {} })).toBeNull();
    expect(readSharedLocation({ location: 'Cairo' })).toBeNull();
    expect(readSharedLocation({ location: [30, 31] })).toBeNull();
  });

  it('normalises absent and blank labels to null', () => {
    const bare = readSharedLocation({ location: { latitude: 30, longitude: 31 } });
    expect(bare).toEqual({ latitude: 30, longitude: 31, name: null, address: null });

    const blank = readSharedLocation({
      location: { latitude: 30, longitude: 31, name: '   ', address: '' },
    });
    expect(blank?.name).toBeNull();
    expect(blank?.address).toBeNull();
  });

  it('trims a label rather than passing the whitespace through', () => {
    const read = readSharedLocation({
      location: { latitude: 30, longitude: 31, name: '  Maadi hub  ', address: null },
    });
    expect(read?.name).toBe('Maadi hub');
  });
});

describe('formatCoordinates', () => {
  it('cuts Meta’s float noise back to six places', () => {
    // Real value from the archive: fourteen significant digits, of which the
    // last eight are noise at any human scale.
    expect(
      formatCoordinates({
        latitude: 29.988094329834,
        longitude: 31.282814025879,
        name: null,
        address: null,
      }),
    ).toBe('29.988094, 31.282814');
  });

  it('does not pad a round number with zeros', () => {
    expect(formatCoordinates({ latitude: 30.5, longitude: 31, name: null, address: null })).toBe(
      '30.5, 31',
    );
  });
});

describe('mapUrl', () => {
  it('points at the coordinates', () => {
    expect(mapUrl({ latitude: 30.0444, longitude: 31.2357, name: null, address: null })).toBe(
      'https://www.google.com/maps/search/?api=1&query=30.0444%2C31.2357',
    );
  });

  it('never puts the customer’s text in the URL', () => {
    // A name is text a customer typed. Searching on it would resolve to whatever
    // Google thinks the words mean — a pin in Sohag named "Cairo office" would
    // open a map of Cairo — and it is also the obvious injection seam.
    const url = mapUrl({
      latitude: 26.5666,
      longitude: 31.6879,
      name: 'Cairo office',
      address: '&query=elsewhere',
    });
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=26.5666%2C31.6879');
    expect(url).not.toContain('Cairo');
    expect(url).not.toContain('elsewhere');
  });

  it('handles a southern and western pin', () => {
    expect(mapUrl({ latitude: -33.8688, longitude: -70.6693, name: null, address: null })).toBe(
      'https://www.google.com/maps/search/?api=1&query=-33.8688%2C-70.6693',
    );
  });
});
