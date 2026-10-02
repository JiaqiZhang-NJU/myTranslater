export type Role = 'heading' | 'paragraph' | 'list-item' | 'nav' | 'button' | 'table-header' | 'cell';

/** Page scanning accepts text blocks from 2 to 2200 characters. */
export const BLOCK_MIN_CHARS = 2;
export const BLOCK_MAX_CHARS = 2200;
/** A user selection may be a single character, but never more than 2000. */
export const SELECTION_MIN_CHARS = 1;
export const SELECTION_MAX_CHARS = 2000;

export interface TextBlock {
  id: string;
  role: Role;
  text: string;
  context?: string;
}

export interface TextGroup {
  id: string;
  section?: string;
  blocks: TextBlock[];
}

export interface TranslationBatch {
  pageTitle: string;
  targetLang: 'zh-CN';
  groups: TextGroup[];
  /**
   * 'selection' marks a user-initiated translation of the text they selected.
   * Selection requests allow single-character blocks and a single small group;
   * page requests keep the original per-block and per-batch limits.
   */
  mode?: 'selection';
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TranslationResult {
  translations: { id: string; text: string }[];
  usage: Usage | null;
}

export type ContentMessage =
  | { type: 'GET_PROVIDER_STATUS' }
  | { type: 'TRANSLATE'; sessionId: string; settingsVersion: number; batch: TranslationBatch }
  | { type: 'CANCEL'; sessionId: string }
  | { type: 'EXTEND_BUDGET' }
  | { type: 'OPEN_OPTIONS' };

export function isTranslationBatch(value: unknown): value is TranslationBatch {
  if (!value || typeof value !== 'object') return false;
  const batch = value as Partial<TranslationBatch>;
  if (typeof batch.pageTitle !== 'string' || batch.pageTitle.length > 180 || batch.targetLang !== 'zh-CN' || !Array.isArray(batch.groups)) return false;
  if (batch.mode !== undefined && batch.mode !== 'selection') return false;
  const selection = batch.mode === 'selection';
  if (batch.groups.length < 1 || batch.groups.length > (selection ? 1 : 8)) return false;
  let totalChars = batch.pageTitle.length;
  const ids = new Set<string>();
  for (const group of batch.groups) {
    if (!group || typeof group.id !== 'string' || !/^[\w-]{1,40}$/.test(group.id) || !Array.isArray(group.blocks)) return false;
    if (group.blocks.length < 1 || group.blocks.length > (selection ? 2 : 8)) return false;
    if (group.section !== undefined && (typeof group.section !== 'string' || group.section.length > 180)) return false;
    totalChars += group.section?.length ?? 0;
    for (const block of group.blocks) {
      if (!block || typeof block.id !== 'string' || !/^[\w-]{1,40}$/.test(block.id) || ids.has(block.id)) return false;
      if (!['heading', 'paragraph', 'list-item', 'nav', 'button', 'table-header', 'cell'].includes(block.role)) return false;
      if (typeof block.text !== 'string') return false;
      if (block.text.trim().length < (selection ? SELECTION_MIN_CHARS : BLOCK_MIN_CHARS)) return false;
      if (block.text.length > (selection ? SELECTION_MAX_CHARS : BLOCK_MAX_CHARS)) return false;
      if (block.context !== undefined && (typeof block.context !== 'string' || block.context.length > 120)) return false;
      ids.add(block.id);
      totalChars += block.text.length + (block.context?.length ?? 0);
    }
  }
  if (selection) return ids.size <= 2 && totalChars <= 2400;
  return ids.size <= 12 && totalChars <= 6500;
}
