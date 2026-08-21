import type { ComponentProps } from 'react';

/**
 * Inline icons.
 *
 * Hand-drawn rather than an icon package: the console uses about fifteen, and a
 * dependency would ship several hundred plus a tree-shaking configuration to
 * avoid them. Each is a 24-grid stroke path so they sit together at any size.
 */

type IconProps = ComponentProps<'svg'> & { size?: number };

function Icon({ size = 20, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export function InboxIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 13h4l1.5 3h5L16 13h4" />
      <path d="M5 5h14l1.5 8v5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-5z" />
    </Icon>
  );
}

export function ContactsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 6.5a3 3 0 0 1 0 5.4M17.5 19a5.4 5.4 0 0 0-2-4.2" />
    </Icon>
  );
}

export function BookIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 4.5h9a3 3 0 0 1 3 3V20a2.5 2.5 0 0 0-2.5-2.5H5z" />
      <path d="M5 4.5V20" />
      <path d="M9 9h4.5M9 12.5h4.5" />
    </Icon>
  );
}

export function ChartIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 19h16" />
      <rect x="5.5" y="11" width="3.5" height="6" rx="1" />
      <rect x="10.5" y="7" width="3.5" height="10" rx="1" />
      <rect x="15.5" y="13" width="3.5" height="4" rx="1" />
    </Icon>
  );
}

/**
 * A gear, drawn as eight teeth on a 45-degree spacing rather than as spokes
 * around a hub: at rail size the spokes of the older mark read as a sun, and
 * "settings" is the one icon that has to be unmistakable at a glance.
 */
export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 10.1 21 13.9 18.7 14.4 18.4 15 19.7 17 17 19.7 15 18.4 14.4 18.7 13.9 21 10.1 21 9.6 18.7 9 18.4 7 19.7 4.3 17 5.6 15 5.3 14.4 3 13.9 3 10.1 5.3 9.6 5.6 9 4.3 7 7 4.3 9 5.6 9.6 5.3 10.1 3 13.9 3 14.4 5.3 15 5.6 17 4.3 19.7 7 18.4 9 18.7 9.6Z" />
      <circle cx="12" cy="12" r="3.1" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </Icon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 1.8" />
    </Icon>
  );
}

export function BoltIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13 3 5.5 13.5H11L10.5 21 18.5 10H13z" />
    </Icon>
  );
}

export function TagIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 11.5V5a1 1 0 0 1 1-1h6.5L20 12.5 12.5 20z" />
      <circle cx="8" cy="8" r="1.4" />
    </Icon>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 6.5h12M8 12h12M8 17.5h12" />
      <circle cx="4.3" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4.3" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4.3" cy="17.5" r="1.1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 12.5c0 3.6-3.6 6.5-8 6.5-1 0-2-.15-2.9-.42L4 20l1.3-3.5C4.5 15.4 4 14 4 12.5 4 8.9 7.6 6 12 6s8 2.9 8 6.5z" />
    </Icon>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="9" r="2.8" />
      <circle cx="16.5" cy="9.5" r="2.3" />
      <path d="M3 18.5a5 5 0 0 1 10 0M14.5 18.5a4.3 4.3 0 0 1 6.5-3.7" />
    </Icon>
  );
}

export function PlugIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 3.5v5M15 3.5v5" />
      <path d="M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 17v3.5" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4v10" />
      <path d="m8 10.5 4 4 4-4" />
      <path d="M5 19h14" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m14.5 6-6 6 6 6" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Icon>
  );
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 14.5 6-6 6 6" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5.5v13M5.5 12h13" />
    </Icon>
  );
}

/* ── Help centre ──────────────────────────────────────────────────────────── */

export function DocumentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z" />
      <path d="M13.5 3.5v5h5" />
      <path d="M9 12.5h6M9 16h4" />
    </Icon>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z" />
    </Icon>
  );
}

/** The mark used for a whole category — a shelf of folders. */
export function CategoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="4" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13" width="7" height="7" rx="1.5" />
    </Icon>
  );
}

export function LifeBuoyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="m6 6 3.5 3.5M18 6l-3.5 3.5M6 18l3.5-3.5M18 18l-3.5-3.5" />
    </Icon>
  );
}

export function PrinterIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 9V4.5h10V9" />
      <path d="M7 17.5H5.5A1.5 1.5 0 0 1 4 16v-5.5A1.5 1.5 0 0 1 5.5 9h13a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 1-1.5 1.5H17" />
      <path d="M7 14h10v5.5H7z" />
    </Icon>
  );
}

export function ThumbsUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 20V10l4-6.5a2 2 0 0 1 2 2V10h4.5a2 2 0 0 1 2 2.35l-1.1 6A2 2 0 0 1 16.4 20z" />
      <path d="M7 10H4.5v10H7" />
    </Icon>
  );
}

export function ThumbsDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 4v10l4 6.5a2 2 0 0 0 2-2V14h4.5a2 2 0 0 0 2-2.35l-1.1-6A2 2 0 0 0 16.4 4z" />
      <path d="M7 14H4.5V4H7" />
    </Icon>
  );
}
