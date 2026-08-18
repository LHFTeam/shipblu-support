import { describe, expect, it } from 'vitest';
import {
  TemplateParameterError,
  buildTemplateComponents,
  countVariables,
  renderTemplatePreview,
  templateShape,
} from './templates';

const SHIPMENT_UPDATE = [
  { type: 'HEADER', format: 'TEXT', text: 'Update on order {{1}}' },
  {
    type: 'BODY',
    text: 'Hi {{1}}, your shipment {{2}} is out for delivery today.',
  },
  { type: 'FOOTER', text: 'ShipBlu' },
  {
    type: 'BUTTONS',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Track' },
      { type: 'QUICK_REPLY', text: 'Reschedule' },
    ],
  },
];

describe('countVariables', () => {
  it('counts by highest index, not number of matches', () => {
    // "{{2}} then {{1}}" needs two values even though neither is {{3}}.
    expect(countVariables('{{2}} then {{1}}')).toBe(2);
    // A repeated variable is still one value.
    expect(countVariables('{{1}} and {{1}} again')).toBe(1);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(countVariables('hello {{ 1 }}')).toBe(1);
  });

  it('returns zero for text with no variables', () => {
    expect(countVariables('no variables here')).toBe(0);
    expect(countVariables(null)).toBe(0);
  });
});

describe('templateShape', () => {
  it('reads Meta components into something the composer can render', () => {
    const shape = templateShape(SHIPMENT_UPDATE);

    expect(shape.headerFormat).toBe('TEXT');
    expect(shape.headerVariableCount).toBe(1);
    expect(shape.bodyVariableCount).toBe(2);
    expect(shape.footerText).toBe('ShipBlu');
    expect(shape.buttons.map((b) => b.text)).toEqual(['Track', 'Reschedule']);
  });

  it('does not count variables in a media header', () => {
    const shape = templateShape([
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Your parcel {{1}}' },
    ]);

    expect(shape.headerFormat).toBe('IMAGE');
    expect(shape.headerVariableCount).toBe(0);
    expect(shape.headerText).toBeNull();
  });

  it('handles a template with no components at all', () => {
    const shape = templateShape([]);
    expect(shape.bodyVariableCount).toBe(0);
    expect(shape.buttons).toEqual([]);
  });
});

describe('renderTemplatePreview', () => {
  it('substitutes values by index', () => {
    expect(renderTemplatePreview('Hi {{1}}, order {{2}}', ['Nour', 'SB-991'])).toBe(
      'Hi Nour, order SB-991',
    );
  });

  it('leaves a placeholder in place when no value is supplied yet', () => {
    expect(renderTemplatePreview('Hi {{1}}, order {{2}}', ['Nour'])).toBe('Hi Nour, order {{2}}');
  });
});

describe('buildTemplateComponents', () => {
  const shape = templateShape(SHIPMENT_UPDATE);

  it('builds header and body components in Meta order', () => {
    const components = buildTemplateComponents({
      shape,
      headerValues: ['SB-991'],
      bodyValues: ['Nour', 'SB-991'],
    });

    expect(components).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: 'SB-991' }] },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Nour' },
          { type: 'text', text: 'SB-991' },
        ],
      },
    ]);
  });

  it('rejects the wrong number of body values before Meta does', () => {
    expect(() =>
      buildTemplateComponents({ shape, headerValues: ['SB-991'], bodyValues: ['Nour'] }),
    ).toThrow(TemplateParameterError);
  });

  it('rejects blank values', () => {
    expect(() =>
      buildTemplateComponents({ shape, headerValues: ['SB-991'], bodyValues: ['Nour', '  '] }),
    ).toThrow(/blank/);
  });

  it('requires a media URL for a media header', () => {
    const mediaShape = templateShape([
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Your parcel arrives today' },
    ]);

    expect(() => buildTemplateComponents({ shape: mediaShape, bodyValues: [] })).toThrow(
      /needs a media URL/,
    );

    expect(
      buildTemplateComponents({
        shape: mediaShape,
        bodyValues: [],
        headerMediaUrl: 'https://cdn.shipblu.com/x.jpg',
      }),
    ).toEqual([
      {
        type: 'header',
        parameters: [{ type: 'image', image: { link: 'https://cdn.shipblu.com/x.jpg' } }],
      },
    ]);
  });

  it('emits nothing for a template with no variables', () => {
    const plain = templateShape([{ type: 'BODY', text: 'We are closed for the holiday.' }]);
    expect(buildTemplateComponents({ shape: plain, bodyValues: [] })).toEqual([]);
  });
});
