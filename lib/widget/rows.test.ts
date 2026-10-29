import { describe, expect, it } from 'vitest';
import { switchNotice, webchatSwitch, widgetRow, type ReportedRow } from './rows';

/** Rows oldest first, as every caller passes them. */
function rows(...spec: [string, boolean, boolean?][]): ReportedRow[] {
  return spec.map(([name, isActive, hasFaqFolders = true]) => ({
    id: name.toLowerCase(),
    name,
    isActive,
    hasFaqFolders,
  }));
}

describe('widgetRow', () => {
  it('is the oldest active row, and none when every row is off', () => {
    expect(widgetRow(rows(['Old', false], ['Mid', true], ['New', true]))?.name).toBe('Mid');
    expect(widgetRow(rows(['Old', false]))).toBeNull();
  });
});

describe('webchatSwitch', () => {
  it('refuses the only active row, whatever else is off', () => {
    expect(webchatSwitch(rows(['Chat', true]), 'chat')).toEqual({ kind: 'only_row' });
    expect(webchatSwitch(rows(['Old', false], ['Chat', true]), 'chat')).toEqual({
      kind: 'only_row',
    });
  });

  // Off on the widget's row hands the widget to the next oldest active row,
  // skipping one that is off.
  it('moves the widget on when its own row goes off', () => {
    const plan = webchatSwitch(rows(['Old', true], ['Mid', false], ['New', true]), 'old');
    expect(plan).toMatchObject({ kind: 'switch_off', widgetMovesTo: { name: 'New' } });
  });

  it('leaves the widget where it is when another row goes off', () => {
    expect(webchatSwitch(rows(['Old', true], ['New', true]), 'new')).toEqual({
      kind: 'switch_off',
      widgetMovesTo: null,
    });
  });

  // On for a row older than the widget's takes the widget over; on for a
  // newer one changes nothing the widget does.
  it('says whether a row switched on takes the widget', () => {
    const list = rows(['Old', false], ['Mid', true], ['New', false]);
    expect(webchatSwitch(list, 'old')).toEqual({ kind: 'switch_on', takesWidget: true });
    expect(webchatSwitch(list, 'new')).toEqual({ kind: 'switch_on', takesWidget: false });
    expect(webchatSwitch(rows(['Only', false]), 'only')).toEqual({
      kind: 'switch_on',
      takesWidget: true,
    });
  });

  it('answers null for a row it was not given', () => {
    expect(webchatSwitch(rows(['Chat', true]), 'gone')).toBeNull();
  });
});

describe('switchNotice', () => {
  it('names where the widget went, and what it shows there', () => {
    expect(switchNotice(rows(['Old', true], ['New', true, false]), 'old', false)).toBe(
      '“Old” is off, and the widget now uses “New”, the oldest active web chat row. It lists no FAQ questions yet, so the widget shows the most-read articles until some are chosen under Chat widget.',
    );
    expect(switchNotice(rows(['Old', true], ['New', true]), 'old', false)).toBe(
      '“Old” is off, and the widget now uses “New”, the oldest active web chat row.',
    );
  });

  it('says when the widget stayed where it was', () => {
    expect(switchNotice(rows(['Old', true], ['New', true]), 'new', false)).toBe(
      '“New” is off. The widget still uses “Old”.',
    );
    expect(switchNotice(rows(['Old', true], ['New', false]), 'new', true)).toBe(
      '“New” is on, but the widget still uses “Old”, the oldest active web chat row, so nothing is filed under this one.',
    );
  });

  it('says when a row switched on took the widget over', () => {
    expect(switchNotice(rows(['Old', false, false], ['New', true]), 'old', true)).toBe(
      '“Old” is on, and the widget now uses it, as the oldest active web chat row. It lists no FAQ questions yet, so the widget shows the most-read articles until some are chosen under Chat widget.',
    );
  });
});
