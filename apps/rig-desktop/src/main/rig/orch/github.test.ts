import { describe, expect, it } from 'vitest';
import { ghReadArgs } from './github';

describe('rig_github: gh reads only, as arguments', () => {
  it('turns a read into its arguments, jq filter kept whole', () => {
    expect(ghReadArgs('gh pr view 343 --repo Ulysholdings/mobile-ios-v2 --json state,reviews')).toEqual(['pr', 'view', '343', '--repo', 'Ulysholdings/mobile-ios-v2', '--json', 'state,reviews']);
    expect(ghReadArgs("gh pr list --repo o/r --json number --jq '.[] | .number'")).toEqual(['pr', 'list', '--repo', 'o/r', '--json', 'number', '--jq', '.[] | .number']);
  });

  it('refuses writes, chains and anything that is not gh', () => {
    expect(ghReadArgs('gh pr merge 343')).toBeNull();
    expect(ghReadArgs('gh pr view 1; rm -rf ~')).toBeNull();
    expect(ghReadArgs('gh pr view $(whoami)')).toBeNull();
    expect(ghReadArgs('gh api -X DELETE repos/o/r')).toBeNull();
    expect(ghReadArgs('curl https://example.com')).toBeNull();
  });
});
