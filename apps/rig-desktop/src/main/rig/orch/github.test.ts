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
    const env = ghEnv({ PATH: '/usr/bin', HOME: '/Users/someone', GH_FAKE_SETTING: 'a', XDG_CONFIG_HOME: '/x', HTTPS_PROXY: 'p', RIG_FAKE_SECRET: 'b', ANTHROPIC_FAKE_KEY: 'c', ELECTRON_FAKE_FLAG: 'd' });
    expect(Object.keys(env).sort()).toEqual(['GH_FAKE_SETTING', 'GH_PROMPT_DISABLED', 'HOME', 'HTTPS_PROXY', 'NO_COLOR', 'PATH', 'XDG_CONFIG_HOME']);
  });
});
