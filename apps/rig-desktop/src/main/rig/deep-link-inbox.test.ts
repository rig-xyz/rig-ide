import { describe, expect, it, vi } from 'vitest';
import { DeepLinkInbox } from './deep-link-inbox';

describe('DeepLinkInbox', () => {
  it('queues a cold-start link until the renderer drains it', () => {
    const deliver = vi.fn();
    const inbox = new DeepLinkInbox<string>(deliver);

    expect(inbox.push('a')).toBe('queued');
    expect(deliver).not.toHaveBeenCalled();
    expect(inbox.drain()).toBe('a');
    expect(inbox.drain()).toBeNull(); // one-shot
  });

  it('keeps only the newest unconfirmed link', () => {
    const inbox = new DeepLinkInbox<string>(vi.fn());
    inbox.push('a');
    inbox.push('b');
    expect(inbox.drain()).toBe('b');
  });

  it('drains to null when nothing arrived first', () => {
    expect(new DeepLinkInbox<string>(vi.fn()).drain()).toBeNull();
  });

  it('delivers live once drained, without also queueing', () => {
    const deliver = vi.fn();
    const inbox = new DeepLinkInbox<string>(deliver);
    inbox.drain();

    expect(inbox.push('a')).toBe('delivered');
    expect(deliver).toHaveBeenCalledWith('a');
    expect(inbox.drain()).toBeNull(); // a reload won't replay an already-delivered link
  });

  it('queues again after a reset (renderer reload or closed window) until the next drain', () => {
    const deliver = vi.fn();
    const inbox = new DeepLinkInbox<string>(deliver);
    inbox.drain();
    inbox.reset();

    expect(inbox.push('a')).toBe('queued');
    expect(deliver).not.toHaveBeenCalled();
    expect(inbox.drain()).toBe('a');
    expect(inbox.push('b')).toBe('delivered');
    expect(deliver).toHaveBeenCalledWith('b');
  });
});
