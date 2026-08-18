/**
 * `turndown-plugin-gfm` ships no types (MIT, same author family as
 * turndown). Only the aggregate `gfm` plugin is used (tables +
 * strikethrough + task lists) — typed against turndown's own Plugin shape.
 */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}
