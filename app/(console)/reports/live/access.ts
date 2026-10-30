import type { Permission } from '@/lib/auth/permissions';

/**
 * The key the live dashboard opens to. Read by the page's own guard and by the
 * two links to it — the Reports hub and the settings home — so a change to who
 * may watch the board cannot leave a link offering it to somebody the page
 * turns away. Not on the settings map, whose rule holds every entry to a page
 * under `/admin`; the board is a report. Why it is `admin.agents` and not
 * `report.view` is on the page.
 */
export const LIVE_DASHBOARD_PERMISSION: Permission = 'admin.agents';
