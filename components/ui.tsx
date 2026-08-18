import type { ComponentProps, ReactNode } from 'react';

/**
 * Small shared primitives.
 *
 * Deliberately not a component library: the console needs about six repeated
 * shapes, and a dependency would cost more in bundle size and upgrade churn
 * than it saves. Everything here is a styled element with no behaviour.
 */

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  const styles = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50',
    secondary:
      'border border-[var(--border)] bg-[var(--background)] hover:bg-[var(--muted)] disabled:opacity-50',
    ghost: 'hover:bg-[var(--muted)] disabled:opacity-50',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50',
  }[variant];

  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
    />
  );
}

export function Input({ className = '', ...props }: ComponentProps<'input'>) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 ${className}`}
    />
  );
}

export function Textarea({ className = '', ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      {...props}
      className={`w-full resize-y rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 ${className}`}
    />
  );
}

export function Select({ className = '', ...props }: ComponentProps<'select'>) {
  return (
    <select
      {...props}
      className={`w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm outline-none focus:border-brand-500 ${className}`}
    />
  );
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium opacity-70">
      {children}
    </label>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'open' | 'pending' | 'resolved' | 'closed' | 'warning' | 'danger';
}) {
  const styles = {
    neutral: 'bg-[var(--muted)] opacity-80',
    open: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    pending: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    resolved: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
    closed: 'bg-[var(--muted)] opacity-60',
    warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    danger: 'bg-red-500/15 text-red-700 dark:text-red-300',
  }[tone];

  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${styles}`}
    >
      {children}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
    >
      {children}
    </p>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-12 text-center">
      <p className="text-sm font-medium opacity-70">{title}</p>
      {hint ? <p className="text-xs opacity-50">{hint}</p> : null}
    </div>
  );
}
