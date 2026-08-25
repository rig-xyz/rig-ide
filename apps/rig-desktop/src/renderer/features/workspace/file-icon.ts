import archive1x from '../../assets/icons/files/archive@1x.png';
import archive2x from '../../assets/icons/files/archive@2x.png';
import document1x from '../../assets/icons/files/document@1x.png';
import document2x from '../../assets/icons/files/document@2x.png';
import image1x from '../../assets/icons/files/image@1x.png';
import image2x from '../../assets/icons/files/image@2x.png';
import note1x from '../../assets/icons/files/note@1x.png';
import note2x from '../../assets/icons/files/note@2x.png';
import skill1x from '../../assets/icons/files/skill@1x.png';
import skill2x from '../../assets/icons/files/skill@2x.png';
import table1x from '../../assets/icons/files/table@1x.png';
import table2x from '../../assets/icons/files/table@2x.png';
import { extensionOf } from '@renderer/features/artifact/file-type';

/**
 * File-navigator redesign (`docs/file-navigator-design.md` §2): the curated
 * icon set, extension → type mapping, and type → tint mapping — one shared
 * module so a later slice (card rail, filters) reads the same vocabulary
 * `file-tree.tsx` renders with, per the design doc's "type -> color mapping
 * must agree" requirement.
 *
 * Assets are Microsoft Fluent Emoji 3D (MIT — see
 * `assets/icons/files/NOTICE.md` for full attribution/license text and the
 * exact source glyph each type was picked from), vendored at `@1x`
 * (18×18) / `@2x` (36×36) for the tree's ~18px row icons. `folder` is
 * NOT one of these — it's an owned SVG (`folder-icon.tsx`), not vendored
 * raster art, per the design doc's explicit call-out.
 *
 * `note` exists in the curated set (and this type union) but is not wired
 * to any extension below — the design doc lists "decision/note" as one of
 * the seven glyphs to curate for this visual pass without specifying what
 * distinguishes a "decision/note" file from an ordinary markdown document;
 * inventing that signal (e.g. a `type:` front-matter convention) is out of
 * scope for this slice. `skill` is likewise never returned by
 * `fileIconTypeFor` — which glyph is skill is a PATH decision
 * (`classifyEntryCategory`), not an extension one, so callers choose it
 * directly rather than through this function.
 */

export type FileIconType = 'document' | 'table' | 'image' | 'note' | 'skill' | 'archive';

export type FileIconAsset = { src1x: string; src2x: string };

export const FILE_ICON_ASSETS: Record<FileIconType, FileIconAsset> = {
  document: { src1x: document1x, src2x: document2x },
  table: { src1x: table1x, src2x: table2x },
  image: { src1x: image1x, src2x: image2x },
  note: { src1x: note1x, src2x: note2x },
  skill: { src1x: skill1x, src2x: skill2x },
  archive: { src1x: archive1x, src2x: archive2x },
};

/**
 * The tint each icon type reads with elsewhere (folder tints, and any
 * future card-rail/filter chip) — deliberately just two values: this app's
 * token palette (`renderer/tokens.css`) has exactly one accent color today,
 * no per-category palette, so `accent` (reserved for skills, the one
 * deliberately eye-catching category) and `neutral` (everything else) is
 * the whole vocabulary until more accent tokens exist.
 */
export type FileIconTint = 'neutral' | 'accent';

export const FILE_ICON_TINT: Record<FileIconType, FileIconTint> = {
  document: 'neutral',
  table: 'neutral',
  image: 'neutral',
  note: 'neutral',
  archive: 'neutral',
  skill: 'accent',
};

const TABLE_EXTENSIONS = new Set(['csv', 'tsv', 'xlsx']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'rar', '7z']);

/**
 * Extension → icon type for a FILE row. Never returns `'skill'` (a path
 * decision, see this module's header comment) — callers checking
 * `classifyEntryCategory(relPath) === 'skills'` should use the `skill`
 * asset directly instead of calling this. Everything not recognized as
 * table/image/archive — markdown, known text/code, and genuinely unknown
 * extensions alike — reads as `document`, the generic file glyph.
 */
export function fileIconTypeFor(name: string): FileIconType {
  const ext = extensionOf(name);
  if (TABLE_EXTENSIONS.has(ext)) return 'table';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
  return 'document';
}
