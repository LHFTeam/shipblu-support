/**
 * The bounds on the survey's numbers, shared by the admin form's native
 * validation and the action that refuses what the browser let through. Two
 * copies drifted apart would have the browser refuse a value the server
 * accepts, or the other way round. Pure, so the form's client bundle can hold
 * it without the settings module's database client.
 */
export const MAX_DELAY_MINUTES = 7 * 24 * 60;
export const MAX_RESURVEY_DAYS = 365;
