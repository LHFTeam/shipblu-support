/**
 * The widget renders inside an iframe on someone else's page, so it gets its
 * own full-height layout rather than the console shell.
 */
export default function WidgetLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-dvh bg-[var(--background)]">{children}</div>;
}
