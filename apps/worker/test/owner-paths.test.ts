// The owner's paths (docs/privacy.md 5.10, D-88): a pull request that changes one is merged by the owner, not by a
// session. tools/ci/owner-paths.mjs reads them from .github/CODEOWNERS.
import { describe, expect, it } from 'vitest';
import { ownedFiles, ownerPaths } from '../../../tools/ci/owner-paths.mjs';

const CODEOWNERS = `# a comment

/packages/seal/ @owner
/apps/web/src/copy/vault.ts @owner
/.github/ @owner
`;

describe('owner paths', () => {
  it('reads files and folders from CODEOWNERS', () => {
    expect(ownerPaths(CODEOWNERS)).toEqual(['packages/seal/', 'apps/web/src/copy/vault.ts', '.github/']);
  });

  it('matches a folder by prefix and a file exactly', () => {
    const paths = ownerPaths(CODEOWNERS);
    expect(
      ownedFiles(
        [
          'packages/seal/src/hpke.ts',
          'packages/sealed/x.ts',
          'apps/web/src/copy/vault.ts',
          'apps/web/src/copy/vault.test.ts',
          'apps/web/src/copy/copy.ts',
          '.github/workflows/ci.yml',
          'docs/privacy.md',
        ],
        paths,
      ),
    ).toEqual(['packages/seal/src/hpke.ts', 'apps/web/src/copy/vault.ts', '.github/workflows/ci.yml']);
  });

  it('matches nothing when no owner path changed', () => {
    expect(ownedFiles(['apps/worker/src/routes/api.ts'], ownerPaths(CODEOWNERS))).toEqual([]);
  });
});
