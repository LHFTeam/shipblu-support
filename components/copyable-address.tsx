/**
 * An address shown for somebody to copy into a message to a customer: all of
 * it, broken wherever it must be to fit a phone, and selected whole with one
 * tap, since a phone is where the console is read and dragging across a long
 * URL there is where a character gets lost. One shape for every place that
 * shows the link to send (`articleLinks` in `lib/kb/site.ts`).
 */
export function CopyableAddress({ address }: { address: string }) {
  return <span className="break-all text-(--color-text-primary) select-all">{address}</span>;
}
