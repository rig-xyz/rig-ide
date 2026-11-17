import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {}, session: {} }));

import { lookWrapper, viewLookTool, VIEW_LOOK_TOOL } from './view-look';
import type { RigToolScope } from '../spaces/rig-tools';

const SCOPE: RigToolScope = { bindingId: 'b1', ownerUserId: 'usr_me', agent: 'claude', cwd: '/rigs/space' };

describe('lookWrapper', () => {
  it('hosts the view in a frame that may only run scripts, and feeds it its data when it is ready', () => {
    const page = lookWrapper('<p>view</p>', '{"n":1}', { id: 'usr_me', name: null });
    expect(page).toContain('sandbox="allow-scripts"');
    expect(page).toContain('"rig:ready"');
    expect(page).toContain('type: "rig:data"');
  });
  it("cannot be closed early by the view's own text", () => {
    const page = lookWrapper('</script><script>alert(1)</script>', '{"t":"</script>"}', { id: 'u', name: null });
    // The only closing script tag is the wrapper's own.
    expect(page.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe('rig_view_look', () => {
  it('draws the named view of the session\'s own space and returns the picture with what the page wrote', async () => {
    const look = vi.fn(async () => ({ png: Buffer.from('png'), errors: ['x is not defined'], hadData: true }));
    const tool = viewLookTool({ look });
    expect(tool.name).toBe(VIEW_LOOK_TOOL);
    const res = await tool.run(SCOPE, { view: 'drafts', height: 3000 });
    expect(look).toHaveBeenCalledWith({ root: '/rigs/space', view: 'drafts', viewer: { id: 'usr_me', name: null }, height: 3000 });
    expect(res.content?.[0]).toEqual({ type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' });
    expect(res.text).toContain('x is not defined');
  });
  it('says so when the page drew without data, or wrote nothing', async () => {
    const tool = viewLookTool({ look: async () => ({ png: Buffer.from('p'), errors: [], hadData: false }) });
    const res = await tool.run(SCOPE, { view: 'drafts' });
    expect(res.text).toContain('data.json is missing or not valid JSON');
    expect(res.text).toContain('The page wrote no errors.');
  });
  it('refuses a name that is not a view folder, and says when there is no page', async () => {
    const look = vi.fn(async () => null);
    const tool = viewLookTool({ look });
    expect((await tool.run(SCOPE, { view: '../secrets' })).isError).toBe(true);
    expect(look).not.toHaveBeenCalled();
    expect((await tool.run(SCOPE, { view: 'gone' })).isError).toBe(true);
  });
});
