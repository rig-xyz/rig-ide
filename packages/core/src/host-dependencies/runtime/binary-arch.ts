import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';

/**
 * CPU architectures a macOS (Mach-O) executable can be built for. Anything
 * else we don't need to reason about is reported as `other`.
 */
export type MachOArch = 'x86_64' | 'arm64' | 'i386' | 'arm' | 'other';

/**
 * Whether this machine can run a given binary. `runnable: true` also covers
 * every case we can't judge (not macOS, not a Mach-O file, e.g. a Node or
 * shell script launcher, unreadable file): only a positive "built for a
 * processor this Mac can't run" verdict excludes a binary.
 */
export type BinaryCompat =
  | { runnable: true }
  | { runnable: false; reason: 'incompatible-arch'; archs: MachOArch[] };

export type BinaryCompatCheck = (path: string) => Promise<BinaryCompat>;

const CPU_ARCH_ABI64 = 0x01000000;
const CPU_TYPE_X86 = 7;
const CPU_TYPE_ARM = 12;
/** Mach-O headers fit comfortably in this many bytes, fat arch tables included. */
const HEADER_BYTES = 4096;
/** A fat header claiming more slices than this is almost certainly a Java class file (same magic). */
const MAX_FAT_ARCHS = 32;

function archFromCpuType(cputype: number): MachOArch {
  switch (cputype) {
    case CPU_TYPE_X86 | CPU_ARCH_ABI64:
      return 'x86_64';
    case CPU_TYPE_ARM | CPU_ARCH_ABI64:
      return 'arm64';
    case CPU_TYPE_X86:
      return 'i386';
    case CPU_TYPE_ARM:
      return 'arm';
    default:
      return 'other';
  }
}

/**
 * Reads the architectures out of a Mach-O header (thin or fat/universal).
 * Returns `null` when the bytes aren't a Mach-O executable at all.
 */
export function parseMachOArchs(header: Uint8Array): MachOArch[] | null {
  if (header.length < 8) return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const magicBE = view.getUint32(0, false);

  // Fat/universal binaries are big-endian on disk: 0xcafebabe (32-bit
  // offsets, 20-byte entries) or 0xcafebabf (64-bit offsets, 32-byte entries).
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
    const count = view.getUint32(4, false);
    if (count === 0 || count > MAX_FAT_ARCHS) return null;
    const entrySize = magicBE === 0xcafebabe ? 20 : 32;
    const archs: MachOArch[] = [];
    for (let i = 0; i < count; i++) {
      const offset = 8 + i * entrySize;
      if (offset + 4 > header.length) break;
      archs.push(archFromCpuType(view.getInt32(offset, false)));
    }
    return archs.length > 0 ? archs : null;
  }

  // Thin binaries: MH_MAGIC(_64) in host (little-endian) byte order, or
  // byte-swapped (MH_CIGAM(_64)) for big-endian builds.
  const magicLE = view.getUint32(0, true);
  if (magicLE === 0xfeedface || magicLE === 0xfeedfacf) {
    return [archFromCpuType(view.getInt32(4, true))];
  }
  if (magicBE === 0xfeedface || magicBE === 0xfeedfacf) {
    return [archFromCpuType(view.getInt32(4, false))];
  }
  return null;
}

/** Reads the first bytes of `path` and parses its Mach-O architectures; `null` if not Mach-O or unreadable. */
export async function readMachOArchs(path: string): Promise<MachOArch[] | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const buffer = new Uint8Array(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return parseMachOArchs(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

let rosettaAvailable: Promise<boolean> | null = null;

/**
 * Whether Rosetta 2 can run x86_64 code on this Mac. Asks the OS directly:
 * `arch -x86_64 /usr/bin/true` runs the (universal) system `true` through
 * Rosetta, and fails with "Bad CPU type in executable" when it isn't
 * installed — which is also the case on macOS versions that ship without
 * Rosetta at all. Cached for the life of the process (a few ms, once).
 */
export function isRosettaAvailable(): Promise<boolean> {
  rosettaAvailable ??= new Promise((resolve) => {
    execFile('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { timeout: 5_000 }, (error) =>
      resolve(!error)
    );
  });
  return rosettaAvailable;
}

/**
 * The architectures this machine runs natively or through translation, or
 * `null` when we don't judge (non-Apple-silicon hosts, where an x64 process
 * might itself be translated and arm64 binaries could still run).
 */
export async function hostRunnableArchs(
  deps: { arch?: string; rosetta?: () => Promise<boolean> } = {}
): Promise<Set<MachOArch> | null> {
  const arch = deps.arch ?? process.arch;
  if (arch !== 'arm64') return null;
  const archs = new Set<MachOArch>(['arm64']);
  if (await (deps.rosetta ?? isRosettaAvailable)()) archs.add('x86_64');
  return archs;
}

/** Pure verdict: can a binary built for `binaryArchs` run on a host that runs `hostArchs`? */
export function compatFromArchs(
  binaryArchs: MachOArch[] | null,
  hostArchs: Set<MachOArch> | null
): BinaryCompat {
  if (!binaryArchs || !hostArchs) return { runnable: true };
  if (binaryArchs.some((arch) => hostArchs.has(arch))) return { runnable: true };
  return { runnable: false, reason: 'incompatible-arch', archs: binaryArchs };
}

/**
 * Checks a local binary on macOS: reads its Mach-O header and compares it
 * against what this Mac can run (native arm64, plus x86_64 only when Rosetta
 * is installed). Cheap — one small file read, and one cached `arch` probe.
 */
export async function checkLocalBinaryCompat(path: string): Promise<BinaryCompat> {
  if (process.platform !== 'darwin') return { runnable: true };
  const hostArchs = await hostRunnableArchs();
  if (!hostArchs) return { runnable: true };
  return compatFromArchs(await readMachOArchs(path), hostArchs);
}

/** "Intel Macs" / "Apple silicon" — how people know these, not CPU type names. */
function describeArchs(archs: MachOArch[]): string {
  if (archs.every((arch) => arch === 'x86_64' || arch === 'i386')) return 'Intel Macs';
  if (archs.every((arch) => arch === 'arm64' || arch === 'arm')) return 'Apple silicon Macs';
  return 'a different kind of Mac';
}

/**
 * The plain-language reason shown when the only binary we found can't run
 * here, e.g. "Claude Code (/usr/local/bin/claude) is built for Intel Macs
 * and this Mac can't run it. Reinstall it: curl -fsSL … | bash".
 */
export function describeIncompatibleBinary(opts: {
  name: string;
  path: string;
  archs: MachOArch[];
  installCommand?: string;
}): string {
  const reinstall = opts.installCommand
    ? ` Reinstall it: ${opts.installCommand}`
    : ' Reinstall it, then try again.';
  return `${opts.name} (${opts.path}) is built for ${describeArchs(opts.archs)} and this Mac can't run it.${reinstall}`;
}
