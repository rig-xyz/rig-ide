import type { Result } from '@emdash/shared';
import type {
  RigContextAnchor,
  RigContextCreateTargetError,
  RigContextCreateTargetInput,
  RigContextCreateTargetResult,
} from '@shared/rig/context';

type Entry = {
  owner: symbol;
  wholeDocumentRef: string | null;
  selectionRef: string | null;
  hasSelection: boolean;
};

export class ActiveDocumentHandle {
  private disposed = false;

  constructor(
    private readonly registry: ActiveDocumentContextRegistry,
    readonly root: string,
    readonly owner: symbol
  ) {}

  setWholeDocumentRef(targetRef: string | null): void {
    if (!this.disposed)
      this.registry.update(this, (entry) => ({ ...entry, wholeDocumentRef: targetRef }));
  }

  setSelectionPending(): void {
    if (!this.disposed) {
      this.registry.update(this, (entry) => ({ ...entry, hasSelection: true, selectionRef: null }));
    }
  }

  setSelectionRef(targetRef: string | null): void {
    if (!this.disposed) {
      this.registry.update(this, (entry) => ({
        ...entry,
        hasSelection: true,
        selectionRef: targetRef,
      }));
    }
  }

  clearSelection(): void {
    if (!this.disposed) {
      this.registry.update(this, (entry) => ({
        ...entry,
        hasSelection: false,
        selectionRef: null,
      }));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registry.remove(this);
  }
}

/**
 * Process-local active-document registry. The artifact and chat panels are
 * siblings, so this is the narrow handoff that survives either panel's React
 * remount without making document state part of a conversation store.
 */
export class ActiveDocumentContextRegistry {
  private readonly entries = new Map<string, Entry>();

  activate(root: string): ActiveDocumentHandle {
    const owner = Symbol(root);
    this.entries.set(root, {
      owner,
      wholeDocumentRef: null,
      selectionRef: null,
      hasSelection: false,
    });
    return new ActiveDocumentHandle(this, root, owner);
  }

  getTargetRef(root: string): string | null {
    const entry = this.entries.get(root);
    if (!entry) return null;
    return entry.hasSelection
      ? (entry.selectionRef ?? entry.wholeDocumentRef)
      : entry.wholeDocumentRef;
  }

  update(handle: ActiveDocumentHandle, updater: (entry: Entry) => Entry): void {
    const current = this.entries.get(handle.root);
    if (!current || current.owner !== handle.owner) return;
    this.entries.set(handle.root, updater(current));
  }

  remove(handle: ActiveDocumentHandle): void {
    const current = this.entries.get(handle.root);
    if (current?.owner === handle.owner) this.entries.delete(handle.root);
  }
}

export const activeDocumentContextRegistry = new ActiveDocumentContextRegistry();

type CreateTarget = (
  input: RigContextCreateTargetInput
) => Promise<Result<RigContextCreateTargetResult, RigContextCreateTargetError>>;

/**
 * Orders asynchronous target validation for one mounted document. A pending or
 * failed passage falls back to the validated whole-document ref; late answers
 * from a previous selection or unmounted document are ignored.
 */
export class RigDocumentContextController {
  private readonly handle: ActiveDocumentHandle;
  private selectionRevision = 0;
  private disposed = false;

  constructor(
    private readonly input: { root: string; rootId: string; relativePath: string },
    private readonly createTarget: CreateTarget,
    registry: ActiveDocumentContextRegistry = activeDocumentContextRegistry,
    private readonly onFailure: (error: RigContextCreateTargetError | unknown) => void = () => {}
  ) {
    this.handle = registry.activate(input.root);
    void this.loadWholeDocument();
  }

  setSelection(anchor: RigContextAnchor | null): void {
    const revision = ++this.selectionRevision;
    if (anchor === null) {
      this.handle.clearSelection();
      return;
    }
    this.handle.setSelectionPending();
    void this.createTarget({
      rootId: this.input.rootId,
      relativePath: this.input.relativePath,
      anchor,
    })
      .then((result) => {
        if (this.disposed || revision !== this.selectionRevision) return;
        if (result.success) this.handle.setSelectionRef(result.data.targetRef);
        else {
          this.handle.setSelectionRef(null);
          this.onFailure(result.error);
        }
      })
      .catch((error: unknown) => {
        if (this.disposed || revision !== this.selectionRevision) return;
        this.handle.setSelectionRef(null);
        this.onFailure(error);
      });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.selectionRevision += 1;
    this.handle.dispose();
  }

  private async loadWholeDocument(): Promise<void> {
    try {
      const result = await this.createTarget({
        rootId: this.input.rootId,
        relativePath: this.input.relativePath,
        anchor: null,
      });
      if (this.disposed) return;
      if (result.success) this.handle.setWholeDocumentRef(result.data.targetRef);
      else this.onFailure(result.error);
    } catch (error) {
      if (!this.disposed) this.onFailure(error);
    }
  }
}
