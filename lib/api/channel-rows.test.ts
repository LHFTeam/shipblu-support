import { describe, expect, it } from 'vitest';
import { apiStateKey, apiSwitch, apiSwitchNotice, appRow, type ApiRow } from './channel-rows';

/** Rows oldest first, as every caller passes them. */
function rows(...spec: [string, boolean][]): ApiRow[] {
  return spec.map(([name, isActive]) => ({ id: name.toLowerCase(), type: 'api', name, isActive }));
}

describe('appRow', () => {
  it('is the oldest active row, and none when every row is off', () => {
    expect(appRow(rows(['Old', false], ['Mid', true], ['New', true]))?.name).toBe('Mid');
    expect(appRow(rows(['Old', false]))).toBeNull();
  });
});

describe('apiSwitch', () => {
  // Unlike the widget's, the only active row may go off: it is how new
  // tickets from the app are stopped. The plan says it is the last.
  it('lets the only active row go off, and says it is the last', () => {
    expect(apiSwitch(rows(['App', true]), 'app')).toEqual({
      kind: 'switch_off',
      appMovesTo: null,
      last: true,
    });
    expect(apiSwitch(rows(['Old', false], ['App', true]), 'app')).toMatchObject({ last: true });
  });

  it('moves the app on when its own row goes off, skipping a row that is off', () => {
    expect(apiSwitch(rows(['Old', true], ['Mid', false], ['New', true]), 'old')).toMatchObject({
      kind: 'switch_off',
      appMovesTo: { name: 'New' },
      last: false,
    });
  });

  it('leaves the app where it is when another row goes off', () => {
    expect(apiSwitch(rows(['Old', true], ['New', true]), 'new')).toEqual({
      kind: 'switch_off',
      appMovesTo: null,
      last: false,
    });
  });

  it('says whether a row switched on takes the app', () => {
    const list = rows(['Old', false], ['Mid', true], ['New', false]);
    expect(apiSwitch(list, 'old')).toEqual({ kind: 'switch_on', takesApp: true });
    expect(apiSwitch(list, 'new')).toEqual({ kind: 'switch_on', takesApp: false });
    expect(apiSwitch(rows(['Only', false]), 'only')).toEqual({ kind: 'switch_on', takesApp: true });
  });

  it('is null for a row it was not given', () => {
    expect(apiSwitch(rows(['App', true]), 'gone')).toBeNull();
  });
});

describe('apiStateKey', () => {
  it('names each row and whether it is on, whatever order they come in', () => {
    const list = rows(['Old', false], ['New', true]);
    expect(apiStateKey(list)).toBe('new:on,old:off');
    expect(apiStateKey([...list].reverse())).toBe(apiStateKey(list));
  });
});

describe('apiSwitchNotice', () => {
  it('says what the last row going off stops, and what it does not', () => {
    const notice = apiSwitchNotice(rows(['App', true]), 'app', false);
    expect(notice).toContain('no myBlu app row is on');
    expect(notice).toContain('the app cannot open a new ticket');
    expect(notice).toContain('keep reading and replying on the tickets they have');
  });

  it('names the row the app moves to, or the one it stays on', () => {
    const list = rows(['Old', true], ['New', true]);
    expect(apiSwitchNotice(list, 'old', false)).toBe(
      '“Old” is off, and the app now opens its tickets under “New”, the oldest active myBlu app row.',
    );
    expect(apiSwitchNotice(list, 'new', false)).toBe('“New” is off. The app still uses “Old”.');
  });

  it('says whether a row switched on is the one the app now uses', () => {
    const list = rows(['Old', false], ['Mid', true], ['New', false]);
    expect(apiSwitchNotice(list, 'old', true)).toBe(
      '“Old” is on, and the app opens its new tickets under it, as the oldest active myBlu app row.',
    );
    expect(apiSwitchNotice(list, 'new', true)).toBe(
      '“New” is on, but the app still uses “Mid”, the oldest active myBlu app row, so nothing is filed under this one.',
    );
  });
});
