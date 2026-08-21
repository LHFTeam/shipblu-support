import { describe, expect, it } from 'vitest';
import { csvField, csvFile, csvHeaders, csvRow } from './csv';

describe('csvField', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvField('Ali Hassan')).toBe('Ali Hassan');
    expect(csvField(42)).toBe('42');
  });

  it('quotes a value containing a comma', () => {
    expect(csvField('Hassan, Ali')).toBe('"Hassan, Ali"');
  });

  it('doubles embedded quotes', () => {
    expect(csvField('he said "no"')).toBe('"he said ""no"""');
  });

  it('quotes a value containing a newline', () => {
    // A CSAT comment with a line break in it silently shifts every later column
    // of that row into the wrong header if it goes out unquoted.
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
  });

  it('defuses a value a spreadsheet would run as a formula', () => {
    // Customer-written text reaches this file. Without the prefix, opening the
    // export executes it.
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvField('-2+3')).toBe("'-2+3");
  });

  it('still quotes a formula that also contains a comma', () => {
    expect(csvField('=HYPERLINK("a","b")')).toBe('"\'=HYPERLINK(""a"",""b"")"');
  });

  it('writes an empty cell for null and undefined, not the word', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('writes a date as an unambiguous instant', () => {
    expect(csvField(new Date('2026-08-20T06:00:00.000Z'))).toBe('2026-08-20T06:00:00.000Z');
  });
});

describe('csvRow and csvFile', () => {
  it('joins cells with commas', () => {
    expect(csvRow(['a', 'b', 1])).toBe('a,b,1');
  });

  it('terminates lines with CRLF, which is what Excel reads', () => {
    const file = csvFile(['name', 'count'], [['Ali', 3]]);
    expect(file).toBe('name,count\r\nAli,3\r\n');
  });

  it('writes a header even with no rows', () => {
    expect(csvFile(['name'], [])).toBe('name\r\n');
  });
});

describe('csvHeaders', () => {
  it('strips anything that could break out of the header', () => {
    const headers = csvHeaders('agents "2026".csv') as Record<string, string>;
    expect(headers['Content-Disposition']).toBe('attachment; filename="agents__2026_.csv"');
  });
});
