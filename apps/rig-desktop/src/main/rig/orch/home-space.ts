import { err, ok, type Result } from '@emdash/shared';

/**
 * The person's private Home space (onboarding Step 7): where Rig runs work
 * that has no space of its own, a Feed card's Send and an unbound Start, so
 * neither dead-ends on "No space is on this Mac yet" or "Which space?". Made
 * once, after Set up, or for an existing account the first time it's needed:
 * a space called home already on this Mac is adopted, else a new one is made.
 * Its binding id is kept in settings (`homeSpaceId`).
 */

export type HomeSpace = { bindingId: string; root: string };

export type HomeSpaceDeps = {
  homeSpaceId(): string | null;
  setHomeSpaceId(id: string): void;
  /** The account's spaces, with their folder on this Mac when they have one. */
  spaces(): Promise<Result<{ bindingId: string; name: string; root: string | null }[], { message: string }>>;
  /** Makes a space called `name` and waits until it's live. */
  create(name: string): Promise<Result<HomeSpace, string>>;
  log?: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };
};

export const HOME_SPACE_NAME = 'home';

export function createHomeSpace(deps: HomeSpaceDeps) {
  let ensuring: Promise<Result<HomeSpace, string>> | null = null;

  async function ensureNow(): Promise<Result<HomeSpace, string>> {
    const listed = await deps.spaces();
    if (!listed.success) return err(listed.error.message);
    const id = deps.homeSpaceId();
    const current = id ? listed.data.find((s) => s.bindingId === id) : undefined;
    if (current?.root) return ok({ bindingId: current.bindingId, root: current.root });
    // One already here, from an earlier install or made by hand: use it.
    const named = listed.data.find((s) => s.name === HOME_SPACE_NAME && s.root);
    if (named?.root) {
      deps.setHomeSpaceId(named.bindingId);
      return ok({ bindingId: named.bindingId, root: named.root });
    }
    if (current && !current.root) return err('Your Home space is on another Mac. Open it here first.');
    const made = await deps.create(HOME_SPACE_NAME);
    if (!made.success) {
      deps.log?.warn('Rig home space: could not make it', { error: made.error });
      return made;
    }
    deps.setHomeSpaceId(made.data.bindingId);
    deps.log?.info('Rig home space: made', { bindingId: made.data.bindingId });
    return made;
  }

  /** The Home space, made if there's none yet. Calls while it's being made join that. */
  function ensure(): Promise<Result<HomeSpace, string>> {
    ensuring ??= ensureNow().finally(() => (ensuring = null));
    return ensuring;
  }

  return { ensure };
}
