'use client';

/**
 * Root-level error boundary. Deliberately shows nothing about the failure:
 * support tickets contain customer PII, and a stack trace or error message can
 * leak ticket content or database detail to whoever hit the page.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          /* This boundary replaces the root layout, globals.css included, so the
             one line that pins the app to a light palette has to be repeated
             here, and the colours are the design system's tokens written out
             as literals: canvas, primary and secondary text, the default
             border. None of the custom properties exist on this page. */
          colorScheme: 'light',
          background: '#f6f8fa',
          color: '#1e1e1e',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          margin: 0,
        }}
      >
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Something went wrong</h1>
          <p style={{ color: '#515b68', marginBottom: '1.5rem' }}>
            The error has been logged. Try again, or reload the page.
          </p>
          <button
            onClick={reset}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.375rem',
              border: '1px solid #c7ced7',
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
