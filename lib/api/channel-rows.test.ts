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
  it('names each row, whether it is on and what it is called, whatever order they come in', () => {
    const list = rows(['Old', false], ['New', true]);
    expect(apiStateKey(list)).toBe('new:on:New,old:off:Old');
    expect(apiStateKey([...list].reverse())).toBe(apiStateKey(list));
  });

  // The notice names rows: "the app now opens its tickets under “B”" is wrong
  // once another admin has renamed B, so the page drops it then.
  it('moves when a row is renamed, and no name can forge the separators', () => {
    const list = rows(['Old', false], ['New', true]);
    expect(apiStateKey(list.map((row) => ({ ...row, name: 'Renamed' })))).not.toBe(
      apiStateKey(list),
    );
    expect(apiStateKey([{ id: 'a', type: 'api', name: 'x:on,b', isActive: false }])).toBe(
      'a:off:x%3Aon%2Cb',
    );
  });
});

/** The notice as `switchRow` asks for it: the rows before, and as the switch leaves them. */
function noticeFor(list: readonly ApiRow[], id: string, active: boolean): string {
  const after = list.map((row) => (row.id === id ? { ...row, isActive: active } : row));
  return apiSwitchNotice(list, after, id, active);
}

describe('apiSwitchNotice', () => {
  it('says what the last row going off stops, and what it does not', () => {
    const notice = noticeFor(rows(['App', true]), 'app', false);
    expect(notice).toContain('no myBlu app row is on');
    expect(notice).toContain('the app cannot open a new ticket');
    expect(notice).toContain('keep reading and replying on the tickets they have');
  });

  it('names the row the app moves to, or the one it stays on', () => {
    const list = rows(['Old', true], ['New', true]);
    expect(noticeFor(list, 'old', false)).toBe(
      '“Old” is off, and the app now opens its tickets under “New”, the oldest active myBlu app row.',
    );
    expect(noticeFor(list, 'new', false)).toBe('“New” is off. The app still uses “Old”.');
  });

  it('says whether a row switched on is the one the app now uses', () => {
    const list = rows(['Old', false], ['Mid', true], ['New', false]);
    expect(noticeFor(list, 'old', true)).toBe(
      '“Old” is on, and the app opens its new tickets under it, as the oldest active myBlu app row.',
    );
    expect(noticeFor(list, 'new', true)).toBe(
      '“New” is on, but the app still uses “Mid”, the oldest active myBlu app row, so nothing is filed under this one.',
    );
  });
});
