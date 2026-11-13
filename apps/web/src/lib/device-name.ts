// The name a new passkey gets (Settings → Sign-in and devices lists it; the person can rename it). The kind of
// device and the day, so two passkeys from like devices can be told apart, and never "This device", which is the
// name of a section on that page.

/** "iPhone", "Mac", "Linux computer" and so on, from the browser's user agent. */
export function deviceKind(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (
    /iPad/.test(ua) ||
    (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)
  )
    return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows computer';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'Computer';
}

/** A new passkey's name: "Linux computer, Nov 14". */
export function passkeyName(now = new Date(), ua?: string): string {
  const day = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${deviceKind(ua)}, ${day}`;
}
