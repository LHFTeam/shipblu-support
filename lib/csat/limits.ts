/**
 * The bounds on the survey's numbers, shared by the admin form's native
 * validation and the action that refuses what the browser let through. Two
 * copies drifted apart would have the browser refuse a value the server
 * accepts, or the other way round. Pure, so the form's client bundle can hold
 * it without the settings module's database client.
 *
 * The resurvey window has a floor of a day: at zero, "surveyed inside the
 * window" is never true, and every job for a ticket — the scheduled one and
 * a "Send now" beside it — would survey the customer again.
 */
export const MAX_DELAY_MINUTES = 7 * 24 * 60;
export const MIN_RESURVEY_DAYS = 1;
export const MAX_RESURVEY_DAYS = 365;
