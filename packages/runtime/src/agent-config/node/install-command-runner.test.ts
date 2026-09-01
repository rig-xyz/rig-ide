import { describe, expect, it } from 'vitest';
import { createExecInstallCommandRunner } from './install-command-runner';

function createRunner() {
  return createExecInstallCommandRunner({
    cwd: process.cwd(),
    env: process.env,
    shell: process.env.SHELL ?? '/bin/sh',
  });
}

// Each case spawns a REAL login shell (`$SHELL -lc`, by design — installs must
// see the user's own PATH), whose startup on a machine with a heavy shell rc
// (nvm/conda/theme init) can alone take ~5s: right at vitest's default
// ceiling, so these flaked under load. The product has no such limit; only
// the test ceiling was wrong.
describe('createExecInstallCommandRunner', { timeout: 30_000 }, () => {
  it('succeeds when the command exits cleanly', async () => {
    const result = await createRunner()('printf "installed"');

    expect(result.success).toBe(true);
  });

  it('classifies non-zero exits as command failures with buffered output', async () => {
    const result = await createRunner()('printf "stdout"; printf "stderr" >&2; exit 7');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('command-failed');
      if (result.error.type === 'command-failed') {
        expect(result.error.exitCode).toBe(7);
        expect(result.error.message).toBe('Install command failed.');
        expect(result.error.output).toBe('stdoutstderr');
      }
    }
  });

  it('classifies permission-denied output specially', async () => {
    const result = await createRunner()('printf "permission denied" >&2; exit 13');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe('permission-denied');
      if (result.error.type === 'permission-denied') {
        expect(result.error.exitCode).toBe(13);
        expect(result.error.output).toBe('permission denied');
      }
    }
  });

  it('resolves when the command is aborted', async () => {
    const controller = new AbortController();
    const resultPromise = createRunner()('sleep 5', { signal: controller.signal });

    controller.abort();
    const result = await resultPromise;

    expect(result.success).toBe(false);
  });
});
