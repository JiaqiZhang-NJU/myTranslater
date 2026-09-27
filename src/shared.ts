export type Role = 'heading' | 'paragraph' | 'list-item' | 'nav' | 'button' | 'table-header' | 'cell';

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
  if (batch.groups.length < 1 || batch.groups.length > 8) return false;
  let totalChars = batch.pageTitle.length;
  const ids = new Set<string>();
  for (const group of batch.groups) {
    if (!group || typeof group.id !== 'string' || !/^[\w-]{1,40}$/.test(group.id) || !Array.isArray(group.blocks) || group.blocks.length < 1 || group.blocks.length > 8) return false;
    if (group.section !== undefined && (typeof group.section !== 'string' || group.section.length > 180)) return false;
    totalChars += group.section?.length ?? 0;
    for (const block of group.blocks) {
      if (!block || typeof block.id !== 'string' || !/^[\w-]{1,40}$/.test(block.id) || ids.has(block.id)) return false;
      if (!['heading', 'paragraph', 'list-item', 'nav', 'button', 'table-header', 'cell'].includes(block.role)) return false;
      if (typeof block.text !== 'string' || block.text.trim().length < 2 || block.text.length > 2200) return false;
      if (block.context !== undefined && (typeof block.context !== 'string' || block.context.length > 120)) return false;
      ids.add(block.id);
      totalChars += block.text.length + (block.context?.length ?? 0);
    }
  }
  return ids.size <= 12 && totalChars <= 6500;
}
