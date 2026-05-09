import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('child_process', () => childProcess);

describe('port utils process lookup', () => {
  beforeEach(() => {
    childProcess.execFileSync.mockReset();
    childProcess.execSync.mockReset();
  });

  it('bounds lsof lookup time for non-sudo port scans', async () => {
    childProcess.execSync.mockImplementation(() => {
      throw new Error('command timed out');
    });

    const { findPidsOnPort } = await import('../src/cli/port-utils');

    expect(findPidsOnPort(5050)).toEqual([]);
    expect(childProcess.execSync).toHaveBeenCalledWith(
      'ss -ltnp \'sport = :5050\' 2>/dev/null',
      expect.objectContaining({ timeout: 3000 }),
    );
    expect(childProcess.execSync).toHaveBeenCalledWith(
      'lsof -nP -iTCP:5050 -sTCP:LISTEN -t 2>/dev/null',
      expect.objectContaining({ timeout: 3000 }),
    );
  });

  it('bounds lsof lookup time for sudo port scans', async () => {
    childProcess.execFileSync.mockImplementation(() => {
      throw new Error('command timed out');
    });

    const { findPidsOnPortWithSudo } = await import('../src/cli/port-utils');

    expect(findPidsOnPortWithSudo(5050)).toEqual([]);
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      'sudo',
      ['-n', 'ss', '-ltnp', 'sport = :5050'],
      expect.objectContaining({ timeout: 3000 }),
    );
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      'sudo',
      ['-n', 'lsof', '-nP', '-iTCP:5050', '-sTCP:LISTEN', '-t'],
      expect.objectContaining({ timeout: 3000 }),
    );
  });
});
