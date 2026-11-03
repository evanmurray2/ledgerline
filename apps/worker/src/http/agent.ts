// A short, plain name for the device and browser behind a sign-in, from its User-Agent ("iPhone · Safari"), for
// Settings → Sign-in. Only the name leaves the server; the User-Agent itself is never sent back.

const DEVICES: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'Chromebook'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
];

const BROWSERS: [RegExp, string][] = [
  [/EdgA?\//, 'Edge'],
  [/FxiOS|Firefox\//, 'Firefox'],
  [/CriOS|Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

export function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const device = DEVICES.find(([re]) => re.test(ua))?.[1];
  // The Home Screen app on an iPhone has no "Safari/" token.
  const browser =
    BROWSERS.find(([re]) => re.test(ua))?.[1] ?? (/iPhone|iPad/.test(ua) ? 'Home Screen app' : undefined);
  if (device && browser) return `${device} · ${browser}`;
  return device ?? browser ?? 'Unknown device';
}
