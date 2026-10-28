import { describe, expect, it } from 'vitest';
import { ghReadArgs } from './github';

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
