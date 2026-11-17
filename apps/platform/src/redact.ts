/** Log hygiene for the hosted platform: never let a credential reach a log line. */
/** An error message with anything shaped like a connection string or bearer token removed. */
export function redact(message: string): string {
  return message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*@[^\s'"]*/gi, '[redacted-url]')
    .replace(/\b(sb_secret_|sb_publishable_|gmt_)[A-Za-z0-9_-]+/g, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
}
