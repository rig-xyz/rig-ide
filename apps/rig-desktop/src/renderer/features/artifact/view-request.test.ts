import { beforeEach, describe, expect, it } from 'vitest';
import { getPreviewMode, resetPreviewModeMemoryForTests } from './preview-mode-memory';
import { requestBrowserMode } from './view-request';

describe('requestBrowserMode', () => {
  beforeEach(() => resetPreviewModeMemoryForTests());

  it('remembers Browser for the file, so it opens that way from its first render', () => {
    requestBrowserMode('/space/site/index.html', { passage: 'Pricing' });
    expect(getPreviewMode('/space/site/index.html')).toBe('browser');
    expect(getPreviewMode('/space/site/other.html')).toBe('preview');
  });
});
