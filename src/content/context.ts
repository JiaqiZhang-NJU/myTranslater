import type { TextGroup, TranslationBatch } from '../shared';

export function makeBatches(pageTitle: string, groups: TextGroup[]): TranslationBatch[] {
  const batches: TranslationBatch[] = [];
  let current: TextGroup[] = [];
  let chars = pageTitle.length;
  let blocks = 0;
  const flush = () => {
    if (current.length) batches.push({ pageTitle: pageTitle.slice(0, 180), targetLang: 'zh-CN', groups: current });
    current = [];
    chars = pageTitle.length;
    blocks = 0;
  };
  for (const group of groups) {
    const groupChars = (group.section?.length ?? 0) + group.blocks.reduce((sum, block) => sum + block.text.length + (block.context?.length ?? 0), 0);
    if (current.length && (current.length >= 6 || blocks + group.blocks.length > 12 || chars + groupChars > 3000)) flush();
    current.push(group);
    chars += groupChars;
    blocks += group.blocks.length;
  }
  flush();
  return batches;
}

export function cacheKey(pageTitle: string, group: TextGroup, providerIdentity: string): string {
  return JSON.stringify([pageTitle.slice(0, 180), 'zh-CN', providerIdentity, 2, group.section ?? '', group.blocks.map(block => [block.role, block.text, block.context ?? ''])]);
}
