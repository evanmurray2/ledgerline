import { appendFileSync, mkdirSync } from 'node:fs';
import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

// Keeps a record of every test that failed and then passed on its retry (CI retries once: report.ts). A retry keeps
// `main` green, so without this a flaky test would leave no trace. For each one it writes
//   - a warning on the job (a GitHub annotation titled "Flaky e2e test": `tools/ci/flaky-report.mjs` lists them),
//   - a line in the job's summary page, and
//   - a line in e2e/test-results/flaky-<suite>.md, which makes ci.yml upload the report with the failed try's trace.
export default class RetryLog implements Reporter {
  private readonly suite: string;
  private readonly firstError = new Map<TestCase, string>();
  private readonly flaky: TestCase[] = [];
  private root = '';

  constructor(options: { suite?: string } = {}) {
    this.suite = options.suite ?? 'e2e';
  }

  onBegin(config: FullConfig): void {
    this.root = config.rootDir;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== 'passed' && result.status !== 'skipped' && !this.firstError.has(test)) {
      this.firstError.set(test, oneLine(result.error?.message ?? result.status));
    }
    if (result.status === 'passed' && test.outcome() === 'flaky') this.flaky.push(test);
  }

  onEnd(): void {
    if (!this.flaky.length) return;
    const lines = this.flaky.map((test) => {
      const [, project, file, ...title] = test.titlePath();
      return `${this.suite} [${project}] ${file}:${test.location.line} › ${title.join(' › ')}: ${this.firstError.get(test) ?? 'failed'}`;
    });
    for (const line of lines) {
      // GitHub reads this from the log; anywhere else it is one plain line.
      console.log(`::warning title=Flaky e2e test::${line.replaceAll('%', '%25')}`);
    }
    const md = lines.map((line) => `- Flaky (passed on retry): ${line}\n`).join('');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    const dir = `${this.root}/../test-results`;
    mkdirSync(dir, { recursive: true });
    appendFileSync(`${dir}/flaky-${this.suite}.md`, md);
  }
}

/** The first line of an error, without terminal colors. */
function oneLine(message: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = message.replace(/\u001b\[[0-9;]*m/g, '');
  return (plain.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 200);
}
