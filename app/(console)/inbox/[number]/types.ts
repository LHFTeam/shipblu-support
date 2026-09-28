/**
 * Shapes the ticket page's client components share.
 *
 * A module of their own so that `composer.tsx` need not import `view.tsx`,
 * which renders the composer: that import made the two files a cycle.
 */

export type TemplateOption = {
  id: string;
  name: string;
  language: string;
  category: string;
  components: unknown[];
};
