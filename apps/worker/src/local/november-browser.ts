// The November copy in a browser (the web app's mock API): sql.js's wasm comes from the bundle.
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { novemberCopy } from './november-copy.js';

export const openNovemberCopy = (now: () => number) => novemberCopy(now, () => wasmUrl);
