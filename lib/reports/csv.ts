/**
 * CSV, for reports somebody needs in a spreadsheet.
 *
 * Small on purpose. The interesting part is not the joining, it is the escaping:
 * a support export carries agent names, ticket subjects and free-text CSAT
 * comments, all of which routinely contain commas, quotes and newlines, and any
 * one of them silently shifts every later column of that row into the wrong
 * header if it goes out unquoted.
 */

/**
 * One field, quoted when it has to be.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a quote character as well.
 * Spreadsheets treat those as the start of a formula, so a name or a comment
 * beginning with one is executed on open rather than displayed — which turns an
 * export of attacker-influenced text (a customer's CSAT comment reaches this
 * file) into a way to run something on a manager's machine.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  const text = value instanceof Date ? value.toISOString() : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvField).join(',');
}

/**
 * A whole file, CRLF-terminated.
 *
 * RFC 4180 says CRLF, and Excel on Windows is the tool these end up in — a
 * bare LF is read there as one very wide row.
 */
export function csvFile(header: string[], rows: unknown[][]): string {
  return [csvRow(header), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}

/** Response headers that make a browser save the file under a sensible name. */
export function csvHeaders(filename: string): HeadersInit {
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    // Quoted and stripped of anything that could break out of the header.
    'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`,
    'Cache-Control': 'no-store',
  };
}
