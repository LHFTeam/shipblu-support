import { describe, expect, it } from 'vitest';
import { hasConsoleSession } from './cookie';

function headers(cookie?: string) {
  return new Headers(cookie === undefined ? {} : { cookie });
}

describe('hasConsoleSession', () => {
  it('finds the console cookie among others', () => {
    expect(hasConsoleSession(headers('theme=light; shipblu_session=abc; lang=ar'))).toBe(true);
  });

  it('reads an empty value as no session, as the proxy and getSessionAgent do', () => {
    expect(hasConsoleSession(headers('shipblu_session='))).toBe(false);
    expect(hasConsoleSession(headers('shipblu_session=  ; theme=light'))).toBe(false);
  });

  it('is not fooled by a cookie whose name only starts the same way', () => {
    expect(hasConsoleSession(headers('shipblu_session_old=abc'))).toBe(false);
    expect(hasConsoleSession(headers('xshipblu_session=abc'))).toBe(false);
  });

  it("does not count the customer portal's cookie, or no cookie at all", () => {
    expect(hasConsoleSession(headers('shipblu_customer=abc'))).toBe(false);
    expect(hasConsoleSession(headers())).toBe(false);
  });
});
