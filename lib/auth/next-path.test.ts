import { describe, expect, it } from 'vitest';
import { customerPath, safePath } from './next-path';

describe('safePath', () => {
  it('keeps a same-site path', () => {
    expect(safePath('/inbox/42', '/inbox')).toBe('/inbox/42');
  });

  it('rejects a protocol-relative URL', () => {
    // The one that matters: browsers follow //evil.test off-site, and it passes
    // a naive "starts with a slash" check.
    expect(safePath('//evil.test/phish', '/inbox')).toBe('/inbox');
  });

  it('rejects an absolute URL and anything that is not a path', () => {
    expect(safePath('https://evil.test', '/inbox')).toBe('/inbox');
    expect(safePath('javascript:alert(1)', '/inbox')).toBe('/inbox');
    expect(safePath(null, '/inbox')).toBe('/inbox');
    expect(safePath(undefined, '/inbox')).toBe('/inbox');
    expect(safePath('', '/inbox')).toBe('/inbox');
  });
});

describe('customerPath', () => {
  it('keeps a help centre path in the reader’s own locale', () => {
    expect(customerPath('/ar/portal/t/12', 'ar', '/ar/portal')).toBe('/ar/portal/t/12');
    expect(customerPath('/ar', 'ar', '/ar/portal')).toBe('/ar');
  });

  it('sends a customer carrying a console next to their tickets', () => {
    // The console appends ?next=/inbox to every signed-out request. A customer
    // who followed one of those links cannot use it.
    expect(customerPath('/inbox', 'ar', '/ar/portal')).toBe('/ar/portal');
    expect(customerPath('/admin/agents', 'en', '/en/portal')).toBe('/en/portal');
  });

  it('does not treat the other locale as this one', () => {
    expect(customerPath('/en/portal', 'ar', '/ar/portal')).toBe('/ar/portal');
  });

  it('still rejects an off-site next', () => {
    expect(customerPath('//evil.test/ar/portal', 'ar', '/ar/portal')).toBe('/ar/portal');
  });
});
