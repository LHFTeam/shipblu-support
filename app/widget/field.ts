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
  'w-full min-w-0 rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) text-base text-(--color-text-primary) outline-none transition-colors placeholder:text-(--color-text-tertiary) hover:border-(--color-border-default) focus:border-(--color-border-focus) focus:ring-2 focus:ring-(--color-border-focus)/20 aria-invalid:border-(--color-feedback-danger-fg) aria-invalid:focus:ring-(--color-feedback-danger-fg)/20';
