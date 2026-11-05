import { describe, expect, it } from 'vitest';
import { jsonForScript } from './json-script';

describe('jsonForScript', () => {
  it('cannot close the script element it is written into', () => {
    const out = jsonForScript({ name: 'Results for “</script><script>alert(1)</script>”' });
    expect(out).not.toMatch(/<\/script/i);
    expect(out).not.toContain('<');
  });

  it('cannot open an HTML comment inside the element either', () => {
    expect(jsonForScript({ name: '<!-- x' })).not.toContain('<!--');
  });

  it('means exactly what JSON.stringify meant', () => {
    const value = {
      '@type': 'BreadcrumbList',
      itemListElement: [{ name: 'a < b </script>', item: 'https://help.example/ar/c/شحن' }],
      line: 'one\u2028two\u2029three',
    };
    expect(JSON.parse(jsonForScript(value))).toEqual(value);
  });

  it('escapes the two line terminators JavaScript reads differently from JSON', () => {
    const out = jsonForScript({ line: 'one\u2028two\u2029three' });
    expect(out).not.toMatch(/[\u2028\u2029]/);
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
  });
});
