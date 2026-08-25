/**
 * Makes overlapping asynchronous requests latest-wins without requiring the
 * underlying operation to support cancellation.
 *
 * A caller captures the token returned by `begin()` and checks `isCurrent()`
 * before committing any result. `invalidate()` makes every outstanding token
 * stale, which is useful when the user navigates away while work is pending.
 */
export class LatestRequestGate {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }
}
