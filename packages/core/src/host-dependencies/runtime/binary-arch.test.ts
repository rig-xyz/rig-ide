import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  compatFromArchs,
  describeIncompatibleBinary,
  hostRunnableArchs,
  parseMachOArchs,
  readMachOArchs,
} from './binary-arch';

const CPU_X86_64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;

/** A thin 64-bit Mach-O header (little-endian, as on disk for x86_64/arm64 builds). */
function thin(cputype: number): Uint8Array {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setInt32(4, cputype, true);
  view.setInt32(8, 3, true); // cpusubtype
  view.setUint32(12, 2, true); // MH_EXECUTE
  return bytes;
}

/** A fat/universal header (big-endian), 20-byte fat_arch entries. */
function fat(cputypes: number[], magic = 0xcafebabe): Uint8Array {
  const entry = magic === 0xcafebabe ? 20 : 32;
  const bytes = new Uint8Array(8 + cputypes.length * entry);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, false);
  view.setUint32(4, cputypes.length, false);
  cputypes.forEach((cputype, i) => view.setInt32(8 + i * entry, cputype, false));
  return bytes;
}

describe('parseMachOArchs', () => {
  it('reads a thin x86_64 binary', () => {
    expect(parseMachOArchs(thin(CPU_X86_64))).toEqual(['x86_64']);
  });

  it('reads a thin arm64 binary', () => {
    expect(parseMachOArchs(thin(CPU_ARM64))).toEqual(['arm64']);
  });

  it('reads every slice of a universal binary', () => {
    expect(parseMachOArchs(fat([CPU_X86_64, CPU_ARM64]))).toEqual(['x86_64', 'arm64']);
    expect(parseMachOArchs(fat([CPU_ARM64, CPU_X86_64], 0xcafebabf))).toEqual(['arm64', 'x86_64']);
  });

  it('returns null for things that are not Mach-O executables', () => {
    expect(parseMachOArchs(new TextEncoder().encode('#!/usr/bin/env node\n'))).toBeNull();
    expect(parseMachOArchs(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))).toBeNull(); // ELF
    expect(parseMachOArchs(new Uint8Array(3))).toBeNull();
    // A Java class file shares 0xcafebabe; its "slice count" is its version number.
    expect(parseMachOArchs(new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x41]))).toBeNull();
  });
});

describe('readMachOArchs', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('reads the header from a file on disk, and returns null for unreadable paths', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'binary-arch-'));
    dirs.push(dir);
    const file = path.join(dir, 'claude');
    await writeFile(file, fat([CPU_X86_64, CPU_ARM64]));

    expect(await readMachOArchs(file)).toEqual(['x86_64', 'arm64']);
    expect(await readMachOArchs(path.join(dir, 'missing'))).toBeNull();
  });
});

describe('hostRunnableArchs', () => {
  it('runs arm64 natively and x86_64 only when Rosetta is installed', async () => {
    const without = await hostRunnableArchs({ arch: 'arm64', rosetta: async () => false });
    const withRosetta = await hostRunnableArchs({ arch: 'arm64', rosetta: async () => true });
    expect([...(without ?? [])]).toEqual(['arm64']);
    expect([...(withRosetta ?? [])].sort()).toEqual(['arm64', 'x86_64']);
  });

  it('does not judge on non-arm64 hosts', async () => {
    expect(await hostRunnableArchs({ arch: 'x64', rosetta: async () => false })).toBeNull();
  });
});

describe('compatFromArchs', () => {
  const appleSiliconNoRosetta = new Set(['arm64'] as const);

  it('rejects an Intel-only binary on Apple silicon without Rosetta', () => {
    expect(compatFromArchs(['x86_64'], appleSiliconNoRosetta)).toEqual({
      runnable: false,
      reason: 'incompatible-arch',
      archs: ['x86_64'],
    });
  });

  it('accepts arm64 and universal binaries', () => {
    expect(compatFromArchs(['arm64'], appleSiliconNoRosetta)).toEqual({ runnable: true });
    expect(compatFromArchs(['x86_64', 'arm64'], appleSiliconNoRosetta)).toEqual({ runnable: true });
  });

  it('accepts anything it cannot judge (scripts, unknown hosts)', () => {
    expect(compatFromArchs(null, appleSiliconNoRosetta)).toEqual({ runnable: true });
    expect(compatFromArchs(['x86_64'], null)).toEqual({ runnable: true });
  });
});

describe('describeIncompatibleBinary', () => {
  it('names the program, the path, the processor and the fix', () => {
    expect(
      describeIncompatibleBinary({
        name: 'Claude Code',
        path: '/usr/local/bin/claude',
        archs: ['x86_64'],
        installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
      })
    ).toBe(
      "Claude Code (/usr/local/bin/claude) is built for Intel Macs and this Mac can't run it. Reinstall it: curl -fsSL https://claude.ai/install.sh | bash"
    );
  });
});
