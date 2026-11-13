// The robot check's Worker (wrangler.check.jsonc): its only export is the handler (page.ts has the rest).
import { handleCheck, type CheckEnv } from './page.js';

export default {
  fetch: (req: Request, env: CheckEnv) => handleCheck(req, env),
};
