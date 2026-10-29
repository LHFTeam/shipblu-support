import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChannelRouting, RoutingReadiness } from '@/lib/routing/readiness';
import { RoutingBadge, RoutingReadinessPanel } from './routing-readiness';

/**
 * What the panel says once, above the rows, and only where it is true: the
 * classifier's idleness over a row that would route in Apply, and the missing
 * key over a row that starts routing. Over rows that never would — locked,
 * inactive, second of their type, owned — either notice describes routing
 * that cannot happen.
 */

const row = (values: Partial<ChannelRouting>): ChannelRouting => ({
  id: 'row',
  name: 'Support mailbox',
  type: 'email',
  isActive: true,
  column: 'category',
  mode: 'category',
  routesInApply: true,
  starts: 'live',
  noKey: false,
  warnings: [],
  ...values,
});

function panel(classifier: RoutingReadiness['classifier'], channels: ChannelRouting[]): string {
  return renderToStaticMarkup(
    createElement(RoutingReadinessPanel, {
      readiness: { classifier, categories: [], channels },
      canEditCategories: false,
      canViewReport: false,
    }),
  );
}

const IDLE = 'Idle until the category classifier is in Apply';
const NO_KEY = 'This environment has no TYPESAFE_API_KEY';

describe('the readiness panel', () => {
  it('says the classifier is idle once, over a row that would route in Apply', () => {
    const html = panel({ mode: 'shadow', keyConfigured: true, windowMinutes: 5 }, [
      row({ starts: null }),
      row({ id: 'two', starts: null }),
    ]);
    expect(html.split(IDLE)).toHaveLength(2);
    expect(html).toContain(
      'Idle until the classifier is in Apply; below, what routing would meet then',
    );
  });

  it('says nothing of the classifier over rows that would never route', () => {
    const html = panel({ mode: 'shadow', keyConfigured: true, windowMinutes: 5 }, [
      row({ routesInApply: false, starts: null, warnings: [{ kind: 'inactive' }] }),
    ]);
    expect(html).not.toContain(IDLE);
    expect(html).toContain('New tickets are neither held nor recorded');
  });

  it('warns of a missing key only over a row that starts routing', () => {
    const blind = panel({ mode: 'apply', keyConfigured: false, windowMinutes: 5 }, [
      row({ noKey: true }),
    ]);
    expect(blind).toContain(NO_KEY);
    expect(blind).toContain('5-minute window');

    const inert = panel({ mode: 'apply', keyConfigured: false, windowMinutes: 5 }, [
      row({ routesInApply: false, starts: null, warnings: [{ kind: 'owned', owner: 'Omar' }] }),
    ]);
    expect(inert).not.toContain(NO_KEY);
  });
});

describe('RoutingBadge', () => {
  const badge = (channel: ChannelRouting) =>
    renderToStaticMarkup(createElement(RoutingBadge, { channel }));

  it('never reads as routing without a key', () => {
    expect(badge(row({ noKey: true }))).toContain('By category — no classifier key');
    expect(badge(row({ noKey: true, column: 'category_shadow', starts: 'shadow' }))).toContain(
      'By category — shadow — no classifier key',
    );
  });

  it('says a row that starts nothing is not routing, and a live one nothing more', () => {
    expect(badge(row({ starts: null }))).toContain('By category — not routing');
    expect(badge(row({}))).toMatch(/>By category<\/span>/);
  });
});
