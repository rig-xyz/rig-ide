import { agentResolveStatus } from '@emdash/core/deps/runtime';
import type { DependencyStatus, ProbeResult } from '@emdash/core/deps/runtime';

/**
 * `goose` name collision guard (onboarding round: "honest status labels").
 * On a machine that also has `pressly/goose` (a Go database-migration tool)
 * on PATH — a plain namesake, nothing to do with this agent — the default
 * `agentResolveStatus` reports this dependency "available" on the strength
 * of a matching binary name and a clean `--version` exit code alone; it has
 * no way to know the binary it just ran isn't this agent at all.
 *
 * The two are cheaply distinguishable by their OWN `--version` output,
 * confirmed against both projects' real source:
 *   - pressly/goose (`cmd/goose/main.go`) prints exactly
 *     `fmt.Printf("goose version: %s\n", version)` — the literal substring
 *     "version:" always appears.
 *   - This agent's CLI is a Rust/clap binary declared with
 *     `#[command(name = "goose", version)]` and no custom version string,
 *     so clap's default `--version` output is just `"goose <semver>"` —
 *     the word "version" never appears in it at all.
 *
 * Any probe output matching pressly's signature is therefore never this
 * agent, however cleanly it exits — reported `'missing'`, the honest status
 * for "goose was never actually found," not `'error'` (which would imply a
 * broken install of the right program).
 */
const PRESSLY_GOOSE_VERSION_SIGNATURE = /\bgoose\s+version:/i;

export function isPresslyGooseOutput(result: ProbeResult): boolean {
  return PRESSLY_GOOSE_VERSION_SIGNATURE.test(`${result.stdout}\n${result.stderr}`);
}

export function resolveGooseStatus(result: ProbeResult): DependencyStatus {
  if (isPresslyGooseOutput(result)) return 'missing';
  return agentResolveStatus(result);
}
