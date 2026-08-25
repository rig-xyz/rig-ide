import { randomUUID } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export type RigFileRootErrorKind =
  | 'invalid-root'
  | 'invalid-path'
  | 'stale-root'
  | 'not-found'
  | 'outside-root'
  | 'io-error';

export type RigFileRootError = {
  kind: RigFileRootErrorKind;
  /** Deliberately does not include absolute filesystem paths. */
  message: string;
};

export type RigFileRoot = { rootId: string; canonicalRoot: string };
export type RigFileRootResult<T> =
  | { success: true; data: T }
  | { success: false; error: RigFileRootError };

type ResolveOptions = { allowRoot?: boolean };
const MAX_REGISTERED_ROOTS = 256;

/** Main-process ownership of the filesystem roots exposed to the renderer. */
export class RigFileRootRegistry {
  private readonly roots = new Map<string, string>();
  private pendingRegistrations = 0;

  async register(rootPath: string): Promise<RigFileRootResult<RigFileRoot>> {
    if (!isAbsolute(rootPath)) return failure('invalid-root', 'Root must be absolute.');
    if (this.roots.size + this.pendingRegistrations >= MAX_REGISTERED_ROOTS) {
      return failure('invalid-root', 'Too many roots are open. Close a rig and try again.');
    }
    this.pendingRegistrations += 1;
    try {
      const canonicalRoot = await realpath(rootPath);
      const info = await stat(canonicalRoot);
      if (!info.isDirectory()) return failure('invalid-root', 'Root must be a directory.');
      const rootId = randomUUID();
      this.roots.set(rootId, canonicalRoot);
      return success({ rootId, canonicalRoot });
    } catch {
      return failure('invalid-root', 'Root is not available.');
    } finally {
      this.pendingRegistrations -= 1;
    }
  }

  release(rootId: string): void {
    this.roots.delete(rootId);
  }

  get(rootId: string): string | undefined {
    return this.roots.get(rootId);
  }

  async getVerified(rootId: string): Promise<RigFileRootResult<string>> {
    return this.verifiedRootFor(rootId);
  }

  normalizeRelative(relativePath: string, options: ResolveOptions = {}): RigFileRootResult<string> {
    return validateRelative(relativePath, options.allowRoot ?? false);
  }

  async resolveExisting(
    rootId: string,
    relativePath: string,
    options: ResolveOptions = {}
  ): Promise<RigFileRootResult<string>> {
    const root = await this.verifiedRootFor(rootId);
    if (!root.success) return root;
    const relative = validateRelative(relativePath, options.allowRoot ?? false);
    if (!relative.success) return relative;
    const candidate = path.join(root.data, relative.data);
    try {
      const resolved = await realpath(candidate);
      if (!contains(root.data, resolved))
        return failure('outside-root', 'Path is outside the root.');
      return success(resolved);
    } catch (error) {
      return failure(
        errorCode(error) === 'ENOENT' ? 'not-found' : 'io-error',
        'Path is not available.'
      );
    }
  }

  async resolveWritable(
    rootId: string,
    relativePath: string,
    options: ResolveOptions = {}
  ): Promise<RigFileRootResult<string>> {
    const root = await this.verifiedRootFor(rootId);
    if (!root.success) return root;
    const relative = validateRelative(relativePath, options.allowRoot ?? false);
    if (!relative.success) return relative;
    const parts = relative.data ? relative.data.split('/') : [];
    let current = root.data;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const facts = await lstat(current);
        let resolved = current;
        if (facts.isSymbolicLink()) {
          try {
            resolved = await realpath(current);
          } catch (error) {
            // The link itself exists, so an ENOENT here means a broken link,
            // not a safe missing tail. Never allow a write through it.
            return failure(
              errorCode(error) === 'ELOOP' ? 'outside-root' : 'io-error',
              'Path is not available.'
            );
          }
        }
        if (!contains(root.data, await realpath(resolved))) {
          return failure('outside-root', 'Path is outside the root.');
        }
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT') {
          // No existing ancestor remains; the lexical path is safe because
          // all existing ancestors have already been realpath-checked. Check
          // the registered root once more to catch root replacement during
          // resolution before returning a path to a mutation call.
          const verified = await this.verifiedRootFor(rootId);
          if (!verified.success) return verified;
          return success(path.join(root.data, relative.data));
        }
        return failure(code === 'ELOOP' ? 'outside-root' : 'io-error', 'Path is not available.');
      }
    }
    const verified = await this.verifiedRootFor(rootId);
    if (!verified.success) return verified;
    return success(path.join(root.data, relative.data));
  }

  /**
   * Resolve an entry for rename/remove semantics without dereferencing the
   * final path component. Reads may follow an in-root symlink, but mutating a
   * symlink by a renderer-supplied name is ambiguous and therefore rejected.
   */
  async resolveMutableEntry(
    rootId: string,
    relativePath: string
  ): Promise<RigFileRootResult<string>> {
    const root = await this.verifiedRootFor(rootId);
    if (!root.success) return root;
    const relative = validateRelative(relativePath, false);
    if (!relative.success) return relative;
    const parts = relative.data.split('/');
    const name = parts.pop();
    if (!name) return failure('invalid-path', 'Path is required.');
    const parentRelative = parts.join('/');
    const parent = await this.resolveExisting(rootId, parentRelative, { allowRoot: true });
    if (!parent.success) return parent;
    const candidate = path.join(parent.data, name);
    try {
      const facts = await lstat(candidate);
      if (facts.isSymbolicLink()) {
        return failure('invalid-path', 'Symbolic links cannot be renamed or archived.');
      }
      const resolved = await realpath(candidate);
      if (!contains(root.data, resolved)) {
        return failure('outside-root', 'Path is outside the root.');
      }
      const verified = await this.verifiedRootFor(rootId);
      if (!verified.success) return verified;
      return success(candidate);
    } catch (error) {
      return failure(
        errorCode(error) === 'ENOENT' ? 'not-found' : 'io-error',
        'Path is not available.'
      );
    }
  }

  private rootFor(rootId: string): RigFileRootResult<string> {
    const root = this.roots.get(rootId);
    return root ? success(root) : failure('stale-root', 'Root is no longer registered.');
  }

  private async verifiedRootFor(rootId: string): Promise<RigFileRootResult<string>> {
    const root = this.rootFor(rootId);
    if (!root.success) return root;
    try {
      const current = await realpath(root.data);
      const info = await stat(current);
      if (current !== root.data || !info.isDirectory()) {
        return failure('stale-root', 'Root is no longer available.');
      }
      return root;
    } catch {
      return failure('stale-root', 'Root is no longer available.');
    }
  }
}

export const rigFileRootRegistry = new RigFileRootRegistry();

function validateRelative(input: string, allowRoot: boolean): RigFileRootResult<string> {
  if (input.includes('\0')) return failure('invalid-path', 'Path contains an invalid byte.');
  if (!input && allowRoot) return success('');
  if (!input) return failure('invalid-path', 'Path is required.');
  if (isAbsolute(input)) return failure('invalid-path', 'Path must be relative.');
  const parts = input.replace(/\\/g, '/').split('/');
  if (parts.includes('..')) return failure('invalid-path', 'Parent paths are not allowed.');
  if (parts.some((part) => part === ''))
    return failure('invalid-path', 'Path contains an empty segment.');
  if (parts.length === 1 && parts[0] === '.') {
    return allowRoot ? success('') : failure('invalid-path', 'Path is required.');
  }
  return success(parts.filter((part) => part !== '.').join('/'));
}

function isAbsolute(input: string): boolean {
  return path.posix.isAbsolute(input) || path.win32.isAbsolute(input);
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function success<T>(data: T): RigFileRootResult<T> {
  return { success: true, data };
}

function failure<T = never>(kind: RigFileRootErrorKind, message: string): RigFileRootResult<T> {
  return { success: false, error: { kind, message } };
}
