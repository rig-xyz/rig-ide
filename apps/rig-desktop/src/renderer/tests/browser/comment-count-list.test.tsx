import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentCount } from '@renderer/features/comment-mode/comment-mode-ui';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const count = () => host.querySelector<HTMLElement>('[data-testid="comment-count"]')!;
const listed = () => document.querySelector<HTMLElement>('[data-testid="listed"]');

describe('CommentCount', () => {
  it('without a list, still toggles the resolved threads', async () => {
    const onToggleResolved = vi.fn();
    await act(async () =>
      root.render(
        <CommentCount
          open={1}
          resolved={2}
          showResolved={false}
          onToggleResolved={onToggleResolved}
        />
      )
    );
    await act(async () => click(count()));
    expect(onToggleResolved).toHaveBeenCalledTimes(1);
  });

  it('with a list, opens it on click even with nothing resolved, and closes it from inside', async () => {
    const onToggleResolved = vi.fn();
    await act(async () =>
      root.render(
        <CommentCount
          open={1}
          resolved={0}
          showResolved={false}
          onToggleResolved={onToggleResolved}
          list={(close) => (
            <button type="button" role="menuitem" data-testid="listed" onClick={close}>
              Pin 1
            </button>
          )}
        />
      )
    );
    expect(count().tagName).toBe('BUTTON');
    expect(listed()).toBeNull();
    await act(async () => click(count()));
    expect(count().getAttribute('aria-expanded')).toBe('true');
    expect(listed()).not.toBeNull();
    await act(async () => click(listed()!));
    expect(listed()).toBeNull();
    expect(onToggleResolved).not.toHaveBeenCalled();
  });

  it('says why on a sign-in wall: in its tooltip and atop the list', async () => {
    const note = "This page needs a sign-in, so its pins can't be placed until you sign in.";
    await act(async () =>
      root.render(
        <CommentCount
          open={2}
          resolved={0}
          showResolved={false}
          onToggleResolved={() => {}}
          note={note}
          list={() => (
            <button type="button" role="menuitem" data-testid="listed">
              Pin 1
            </button>
          )}
        />
      )
    );
    expect(count().getAttribute('title')).toBe(note);
    await act(async () => click(count()));
    expect(document.querySelector('[data-testid="comment-count-note"]')?.textContent).toBe(note);
  });
});
