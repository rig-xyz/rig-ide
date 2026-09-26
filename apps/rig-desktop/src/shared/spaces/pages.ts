/**
 * Shapes shared by main and the renderer for web pages opened beside the
 * Room and the pins on them (see main/rig/pages/).
 */

export interface PageAnchorHop {
  /** Which same-origin frame (a canvas board): its words, then its position. */
  index: number;
  sig: string | null;
}

/** Where a pin points, found again after reloads, pan/zoom, edits and reordering. */
export interface PageAnchor {
  /** Cross-origin frames to go through first (origin + index among same-origin siblings). */
  xo: { origin: string; index: number }[];
  hops: PageAnchorHop[];
  /** CSS path within the innermost document. */
  path: string;
  tag: string;
  /** The element's text (trimmed, ≤160 chars); empty for a chart bar or an image. */
  text: string;
  /** Where in the element the pin sits, 0..1. */
  fx: number;
  fy: number;
}

export interface PagePlace {
  found: boolean;
  why?: string;
  /** The pin's point, and the element's size, in the page's viewport. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface PageThreadReply {
  id: string;
  body: string;
  authorName: string | null;
  /** Set when a member's agent wrote it ("Codex (with dylan)"). */
  agent: string | null;
  createdAt: string;
}

export interface PageThread {
  n: number;
  id: string;
  quote: string;
  comment: string;
  authorName: string | null;
  createdAt: string;
  resolved: boolean;
  anchor: PageAnchor;
  replies: PageThreadReply[];
}
