/**
 * The widget's text fields: the design system's input, at 16px on every width.
 *
 * Not the shared `Input`, which drops to 14px from `sm` up. Safari zooms the
 * page in on any focused field smaller than 16px, and a zoomed page is a
 * scrolled one — which on iOS is what parts a caret from the field it belongs
 * to. In the console `sm` means a wider screen; here it means a wider *panel*,
 * and the panel goes full-screen on a landscape phone 844px across, where the
 * shared field would shrink on exactly the device that zooms.
 *
 * No padding, so each caller states its own: two padding utilities on one
 * element are ordered by Tailwind rather than by the class list, and an
 * override written after this string would win only some of the time.
 */
export const WIDGET_FIELD =
  'w-full min-w-0 rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) text-base text-(--color-text-primary) transition-colors placeholder:text-(--color-text-tertiary) hover:border-(--color-border-default) focus:border-(--color-border-focus) focus:ring-2 focus:ring-(--color-border-focus)/20 aria-invalid:border-(--color-feedback-danger-fg) aria-invalid:focus:ring-(--color-feedback-danger-fg)/20';

/**
 * The composer's box: the field's border, surface and focus ring, drawn around
 * the textarea and the two buttons inside it — the emoji at its start and the
 * clip at its end — so they read as one control. Focus is shown on the box
 * whenever anything in it holds focus, the buttons included, which is what a
 * single bordered field looks like to the person using it.
 *
 * While the textarea itself has focus the box also draws the keyboard ring,
 * the global one's width, offset and colour round the whole box: the ring a
 * `WIDGET_FIELD` keeps, where the textarea keeps none of its own. The 20%
 * ring is 1.35:1 and forced colours removes it; an outline survives both. Not
 * for the two buttons, which draw their own ring inside the box.
 *
 * The textarea inside carries no border of its own, and keeps the 16px text
 * `WIDGET_FIELD` gives for Safari's zoom.
 */
export const WIDGET_COMPOSER_BOX =
  'flex min-w-0 flex-1 items-end rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) transition-colors hover:border-(--color-border-default) focus-within:border-(--color-border-focus) focus-within:ring-2 focus-within:ring-(--color-border-focus)/20 has-[textarea:focus-visible]:outline-(length:--focus-width) has-[textarea:focus-visible]:outline-offset-(--focus-offset) has-[textarea:focus-visible]:outline-(--focus-color)';
