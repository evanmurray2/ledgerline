// Where budget lines, month totals and Ready to Assign are worked out (decisions.md D-44, docs/phone-budget.md).
// Off on the server: it stores and syncs what was entered and imported, and nothing derived. On in the phone's local
// engine (src/local), which runs this same code against its own copy. The integration tests turn it on (vitest
// binding LOCAL_ENGINE), so they exercise exactly the code the phone runs.
export const derived = { enabled: false };
