// workerd refuses to start a Worker whose main module exports anything but functions, classes and the default
// handler (a deploy would fail). Integration tests import the module directly, so check the exports here.
import { describe, expect, it } from 'vitest';
import * as main from '../src/index.js';

describe('the Worker module', () => {
  it('exports only functions, classes and the default handler', () => {
    for (const [name, value] of Object.entries(main)) {
      if (name === 'default') expect(typeof (value as { fetch?: unknown }).fetch).toBe('function');
      else expect(typeof value, name).toBe('function');
    }
    expect(Object.keys(main).sort()).toEqual(['BudgetStore', 'Directory', 'default', 'storeUnavailable']);
  });
});
