import { describe, expect, it } from 'vitest';
import { ghEnv, ghReadArgs } from './github';

describe('rig_github: gh reads only, as arguments', () => {
  it('turns a read into its arguments, jq filter kept whole', () => {
    expect(ghReadArgs('gh pr view 343 --repo Ulysholdings/mobile-ios-v2 --json state,reviews')).toEqual(['pr', 'view', '343', '--repo', 'Ulysholdings/mobile-ios-v2', '--json', 'state,reviews']);
    expect(ghReadArgs("gh pr list --repo o/r --json number --jq '.[] | .number'")).toEqual(['pr', 'list', '--repo', 'o/r', '--json', 'number', '--jq', '.[] | .number']);
  });

  it('keeps a double-quoted value whole', () => {
    expect(ghReadArgs('gh pr list --repo o/r --search "is:open 346 OR 353"')).toEqual(['pr', 'list', '--repo', 'o/r', '--search', 'is:open 346 OR 353']);
  });

  it('refuses writes, chains and anything that is not gh', () => {
    expect(ghReadArgs('gh pr merge 343')).toBeNull();
    expect(ghReadArgs('gh pr view 1; rm -rf ~')).toBeNull();
    expect(ghReadArgs('gh pr view $(whoami)')).toBeNull();
    expect(ghReadArgs('gh api -X DELETE repos/o/r')).toBeNull();
    expect(ghReadArgs('curl https://example.com')).toBeNull();
  });

  it('stays on github.com: no --web, and --repo only as owner/repo', () => {
    expect(ghReadArgs('gh pr view 343 --web')).toBeNull();
    expect(ghReadArgs('gh pr view 343 -w')).toBeNull();
    expect(ghReadArgs('gh pr view 343 --repo evil.example.com/o/r')).toBeNull();
    expect(ghReadArgs('gh pr view 343 -R evil.example.com/o/r')).toBeNull();
    expect(ghReadArgs('gh pr view 343 --repo=evil.example.com/o/r')).toBeNull();
    expect(ghReadArgs('gh pr view 343 -Revil.example.com/o/r')).toBeNull();
    expect(ghReadArgs('gh pr view https://evil.example.com/o/r/pull/1')).toBeNull();
    expect(ghReadArgs('gh pr view 343 -R o/r')).toEqual(['pr', 'view', '343', '-R', 'o/r']);
    expect(ghReadArgs('gh pr view https://github.com/o/r/pull/1')).toEqual(['pr', 'view', 'https://github.com/o/r/pull/1']);
  });
});

describe('rig_github: nothing of the app leaves with a read', () => {
  it('refuses a positional HOST/OWNER/REPO and any non-github.com URL', () => {
    expect(ghReadArgs('gh repo view rig-review-test.invalid/a/b')).toBeNull();
    expect(ghReadArgs('gh pr view evil.example.com/o/r#1')).toBeNull();
    expect(ghReadArgs('gh issue view http://github.com/o/r/issues/1')).toBeNull();
    expect(ghReadArgs('gh pr view https://github.com.evil.example.com/o/r/pull/1')).toBeNull();
    expect(ghReadArgs('gh repo view cli/cli')).toEqual(['repo', 'view', 'cli/cli']);
    expect(ghReadArgs('gh issue view https://github.com/o/r/issues/1')).toEqual(['issue', 'view', 'https://github.com/o/r/issues/1']);
  });

  it('refuses a jq filter that reads the environment or other inputs', () => {
    expect(ghReadArgs("gh repo view cli/cli --json name --jq '$ENV|keys|length'")).toBeNull();
    expect(ghReadArgs("gh repo view cli/cli --json name --jq '$ENV.RIG_FAKE_VAR'")).toBeNull();
    expect(ghReadArgs("gh repo view cli/cli --json name --jq '$ ENV'")).toBeNull();
    expect(ghReadArgs("gh repo view cli/cli --json name --jq 'env.RIG_FAKE_VAR'")).toBeNull();
    expect(ghReadArgs("gh repo view cli/cli --json name --jq '\"\\(env)\"'")).toBeNull();
    expect(ghReadArgs("gh repo view cli/cli --json name --jq '[inputs]'")).toBeNull();
    expect(ghReadArgs("gh repo view cli/cli --json name --jq '$__loc__'")).toBeNull();
    // A field or a string named env is not the environment.
    expect(ghReadArgs("gh repo view cli/cli --json name --jq '.env'")).toEqual(['repo', 'view', 'cli/cli', '--json', 'name', '--jq', '.env']);
    expect(ghReadArgs("gh pr list --json title --jq '.[] | select(.title | contains(\"env\"))'")).not.toBeNull();
  });

  it('refuses a filter or template anywhere but the trailing --jq', () => {
    expect(ghReadArgs('gh repo view cli/cli --json name -q env')).toBeNull();
    expect(ghReadArgs('gh repo view cli/cli --json name --jq env')).toBeNull();
    expect(ghReadArgs('gh repo view cli/cli --json name --jq=env')).toBeNull();
    expect(ghReadArgs('gh repo view cli/cli --json name --template {{.name}}')).toBeNull();
    expect(ghReadArgs('gh repo view cli/cli --json name -t {{.name}}')).toBeNull();
  });

  it('runs gh with only what it needs of the environment', () => {
    const env = ghEnv({
      PATH: '/usr/bin', HOME: '/Users/someone', GH_TOKEN: 'v', GH_CONFIG_DIR: '/c', XDG_CONFIG_HOME: '/x',
      GH_HOST: 'v', GH_ENTERPRISE_TOKEN: 'v', GH_FAKE_SETTING: 'v', HTTPS_PROXY: 'v', https_proxy: 'v',
      RIG_FAKE_SECRET: 'v', ANTHROPIC_FAKE_KEY: 'v', ELECTRON_FAKE_FLAG: 'v',
    });
    expect(Object.keys(env).sort()).toEqual(['GH_CONFIG_DIR', 'GH_PROMPT_DISABLED', 'GH_TOKEN', 'HOME', 'NO_COLOR', 'PATH', 'XDG_CONFIG_HOME']);
  });
});

describe('rig_github: only the flags and words each read allows', () => {
  it('refuses clustered short flags, which carry a jq filter or --web', () => {
    expect(ghReadArgs('gh pr view 1 --repo cli/cli --json title -cq.title')).toBeNull();
    expect(ghReadArgs('gh pr view 1 --repo cli/cli --json title -cqenv')).toBeNull();
    expect(ghReadArgs('gh pr view 1 --repo cli/cli --json title -cq env')).toBeNull();
    expect(ghReadArgs('gh issue view 1 --repo cli/cli --json title -cqenv')).toBeNull();
    expect(ghReadArgs('gh pr list --repo cli/cli --json title -dqenv')).toBeNull();
    expect(ghReadArgs('gh pr view 1 --repo cli/cli -wc')).toBeNull();
    expect(ghReadArgs('gh pr list --repo cli/cli -sopen')).toBeNull();
  });

  it('refuses a host given scp-style, or any word with @ before :', () => {
    expect(ghReadArgs('gh repo view git@rig-review.invalid:o/r')).toBeNull();
    expect(ghReadArgs('gh repo view user@rig-review.invalid:o/r')).toBeNull();
    expect(ghReadArgs('gh pr view git@rig-review.invalid:o/r')).toBeNull();
    expect(ghReadArgs('gh pr view user@rig-review.invalid:o/r')).toBeNull();
    expect(ghReadArgs('gh search prs repo:git@rig-review.invalid:o/r')).toBeNull();
    expect(ghReadArgs('gh pr list --repo git@rig-review.invalid:o/r')).toBeNull();
  });

  it('refuses flags a read does not take, and a flag where its value should be', () => {
    expect(ghReadArgs('gh pr view 1 --repo cli/cli --hostname rig-review.invalid')).toBeNull();
    expect(ghReadArgs('gh pr view 1 --state open')).toBeNull();
    expect(ghReadArgs('gh pr view 1 --json -cqenv')).toBeNull();
    expect(ghReadArgs('gh pr list --limit lots')).toBeNull();
    expect(ghReadArgs('gh pr list --draft=true')).toBeNull();
    expect(ghReadArgs('gh pr list -- 1')).toBeNull();
    expect(ghReadArgs('gh pr list 1')).toBeNull();
    expect(ghReadArgs('gh run view abc')).toBeNull();
  });

  it("still runs the orchestrator's own reads", () => {
    // skill.ts and checks.ts: a PR's state, a list, an issue, a search.
    expect(ghReadArgs('gh pr view 342 --repo ulys/mobile-ios --json state,reviews,mergedAt')).not.toBeNull();
    expect(ghReadArgs('gh pr list --repo ulys/mobile-ios --state open --author @me --json number,title')).not.toBeNull();
    expect(ghReadArgs('gh pr list -R ulys/mobile-ios -s merged -L 5 --json number')).not.toBeNull();
    expect(ghReadArgs('gh issue view 12 -Rulys/mobile-ios --json title,state')).not.toBeNull();
    expect(ghReadArgs('gh search prs "is:open review-requested:@me" --json number,repository')).not.toBeNull();
    expect(ghReadArgs('gh search issues fix crash repo:ulys/mobile-ios --state=open')).not.toBeNull();
    // snapshot.ts, exactly.
    expect(ghReadArgs('gh search prs --review-requested=@me --state=open --json repository,number,title,author,updatedAt --limit 20')).toEqual([
      'search', 'prs', '--review-requested=@me', '--state=open', '--json', 'repository,number,title,author,updatedAt', '--limit', '20',
    ]);
    // A PR by branch, slashes and all; checks, a diff, a run, a repository.
    expect(ghReadArgs('gh pr view dylan/fix/feed --repo ulys/mobile-ios --json state')).not.toBeNull();
    expect(ghReadArgs('gh pr checks 342 --repo ulys/mobile-ios --required')).not.toBeNull();
    expect(ghReadArgs('gh pr diff 342 --repo ulys/mobile-ios --name-only')).not.toBeNull();
    expect(ghReadArgs('gh run view 123456 --repo ulys/mobile-ios --log-failed')).not.toBeNull();
    expect(ghReadArgs("gh run list --repo ulys/mobile-ios --branch main --limit 3 --json status --jq '.[0].status'")).not.toBeNull();
    expect(ghReadArgs('gh repo view ulys/mobile-ios --json name,defaultBranchRef')).not.toBeNull();
    expect(ghReadArgs('gh pr status --repo ulys/mobile-ios --json number')).not.toBeNull();
  });
});
