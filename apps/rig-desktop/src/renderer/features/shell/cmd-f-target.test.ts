import { describe, expect, it } from 'vitest';
import { cmdFTarget } from './cmd-f-target';

const base = { editorFocused: false, previewOpen: true } as const;

describe('cmdFTarget', () => {
  it('in a split goes to the pane last clicked when nothing is focused', () => {
    expect(cmdFTarget({ ...base, layout: 'split', lastPane: 'artifact', focus: 'page' })).toBe(
      'doc-reading'
    );
    expect(cmdFTarget({ ...base, layout: 'split', lastPane: 'chat', focus: 'page' })).toBe(
      'chat-search'
    );
  });

  it('in a split follows focus over the last click', () => {
    // The composer is the chat's: Cmd-F there searches the chat.
    expect(cmdFTarget({ ...base, layout: 'split', lastPane: 'artifact', focus: 'chat' })).toBe(
      'chat-search'
    );
    expect(cmdFTarget({ ...base, layout: 'split', lastPane: 'chat', focus: 'artifact' })).toBe(
      'doc-reading'
    );
  });

  it('finds in the editor when the doc is being edited', () => {
    expect(
      cmdFTarget({
        ...base,
        previewOpen: false,
        layout: 'split',
        lastPane: 'artifact',
        focus: 'page',
      })
    ).toBe('doc-editor');
    expect(
      cmdFTarget({
        ...base,
        editorFocused: true,
        layout: 'split',
        lastPane: 'chat',
        focus: 'artifact',
      })
    ).toBe('doc-editor');
  });

  it('is always the doc in the Doc layout and always the chat in the Chat layout', () => {
    expect(cmdFTarget({ ...base, layout: 'files', lastPane: 'chat', focus: 'chat' })).toBe(
      'doc-reading'
    );
    expect(cmdFTarget({ ...base, layout: 'files', lastPane: 'chat', focus: 'page' })).toBe(
      'doc-reading'
    );
    expect(cmdFTarget({ ...base, layout: 'chat', lastPane: 'artifact', focus: 'page' })).toBe(
      'chat-search'
    );
  });

  it('does nothing from an unrelated field, a settings sheet or a dialog', () => {
    expect(cmdFTarget({ ...base, layout: 'split', lastPane: 'chat', focus: 'other' })).toBeNull();
    expect(
      cmdFTarget({ ...base, layout: 'files', lastPane: 'artifact', focus: 'other' })
    ).toBeNull();
    expect(cmdFTarget({ ...base, layout: 'chat', lastPane: 'chat', focus: 'other' })).toBeNull();
  });
});
