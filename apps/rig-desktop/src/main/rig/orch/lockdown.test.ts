import { describe, expect, it } from 'vitest';
import { isReadTool, lockedSession } from './lockdown';

describe('locked-down sessions', () => {
  it('deny what acts or reaches out, and rig_start unless the session is one the person talks to', () => {
    const locked = lockedSession();
    expect(locked).toMatchObject({ noBypassPermissions: true, appPermissionsOnly: true });
    expect(locked.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'mcp__rig__rig_start']));
    expect(lockedSession({ rigStart: true }).disallowedTools).not.toContain('mcp__rig__rig_start');
  });

  it('take a tool for a read only when its name starts as one and nothing in it writes', () => {
    for (const read of ['list_issues', 'get_issue', 'slack_read_thread', 'slack_search_public_and_private', 'query_granola_meetings', 'getJiraIssue', 'searchJiraIssuesUsingJql', 'fetch', 'get_meeting_transcript'])
      expect(isReadTool(read), read).toBe(true);
    for (const write of ['slack_send_message', 'save_issue', 'mark_read', 'slack_mark_read', 'get_or_create_label', 'read_and_delete', 'addCommentToJiraIssue', 'create_event', 'list_then_update', 'download_file_content', 'get_set_status'])
      expect(isReadTool(write), write).toBe(false);
  });
});
