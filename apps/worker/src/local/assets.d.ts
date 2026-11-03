// Vite's `?url` imports (the phone's engine loads sql.js's WebAssembly file by URL; local/web-entry.ts).
declare module '*?url' {
  const url: string;
  export default url;
}
