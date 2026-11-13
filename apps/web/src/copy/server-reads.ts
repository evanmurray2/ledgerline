// Reads the server still answers itself; every other read is worked out from the copy on the device (D-45). The
// mock API (src/mock) uses the same list, so its "resting" scenario pauses what a real phone would have paused.
const SERVER_READS = [
  /^\/api\/session$/,
  /^\/api\/auth\//,
  /^\/api\/settings\/connections$/,
  /^\/api\/settings\/security/,
];

/** True for a read only the server can answer (a path, with or without its query). */
export function isServerRead(path: string): boolean {
  const p = path.split('?')[0]!;
  return SERVER_READS.some((r) => r.test(p));
}
