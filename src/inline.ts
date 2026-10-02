const marker = /⟦(\/?)i(\d+)⟧/g;
const inlineTags = new Set(['A', 'STRONG', 'EM', 'B', 'I']);
// This list must match the extraction rule in `content/extract.ts`: only a
// declared editable region is skipped, so a stand-alone
// `contenteditable="false"` element is still ordinary read-only content.
const skipped = 'script,style,noscript,pre,code,textarea,input,select,[contenteditable]:not([contenteditable="false"]):not([contenteditable="inherit"]),[translate="no"],[aria-hidden="true"],[hidden],template,.mt-translation,#mt-controls,#mt-selection';

export function withoutInlineMarkers(text: string): string {
  return text.replace(marker, '').replace(/\s+/g, ' ').trim();
}

export interface InlineSource {
  text: string;
  elements: Map<string, Element>;
  signature: string;
}

export function extractInline(element: Element, stop?: (node: Element) => boolean): InlineSource {
  const parts: string[] = [];
  const elements = new Map<string, Element>();
  let index = 0;
  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent ?? ''); return; }
    if (!(node instanceof Element) || node.closest(skipped)) return;
    if (node !== element && stop?.(node)) return;
    if (node !== element && element.matches('li,td,th') && node.matches(element.matches('li') ? 'li' : 'td,th')) return;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    const wrapped = node !== element && inlineTags.has(node.tagName);
    const key = wrapped ? `i${++index}` : '';
    if (wrapped) { elements.set(key, node); parts.push(`⟦${key}⟧`); }
    for (const child of node.childNodes) walk(child);
    if (wrapped) parts.push(`⟦/${key}⟧`);
  }
  walk(element);
  return {
    text: parts.join('').replace(/\s+/g, ' ').trim(),
    elements,
    signature: [...elements].map(([key, node]) => [key, node.tagName, node instanceof HTMLAnchorElement ? node.getAttribute('href') : '']).join('|')
  };
}

function tokens(text: string): string[] {
  return [...text.matchAll(marker)].map(match => `${match[1]}${match[2]}`);
}

export function validInlineMarkers(source: string, translation: string): boolean {
  const expected = tokens(source).sort();
  const actual = tokens(translation).sort();
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) return false;
  if (translation.replace(marker, '').includes('⟦') || translation.replace(marker, '').includes('⟧')) return false;
  const stack: string[] = [];
  for (const match of translation.matchAll(marker)) {
    const key = match[2];
    if (match[1]) { if (stack.pop() !== key) return false; }
    else { if (stack.includes(key)) return false; stack.push(key); }
  }
  return stack.length === 0;
}

export function renderInline(text: string, elements: Map<string, Element>): DocumentFragment | null {
  if (elements.size && !text.includes('⟦') && !text.includes('⟧')) {
    const plain = document.createDocumentFragment();
    plain.appendChild(document.createTextNode(text));
    return plain;
  }
  if (!validInlineMarkers([...elements.keys()].map(key => `⟦${key}⟧⟦/${key}⟧`).join(''), text)) return null;
  const fragment = document.createDocumentFragment();
  const stack: Element[] = [];
  let parent: Node = fragment;
  let offset = 0;
  for (const match of text.matchAll(marker)) {
    parent.appendChild(document.createTextNode(text.slice(offset, match.index)));
    offset = match.index + match[0].length;
    const key = `i${match[2]}`;
    if (match[1]) {
      stack.pop();
      parent = stack.at(-1) ?? fragment;
      continue;
    }
    const original = elements.get(key);
    if (!original) return null;
    const tag = original.tagName;
    const safe = document.createElement(tag === 'A' ? 'a' : tag.toLowerCase());
    if (tag === 'A') {
      const href = original.getAttribute('href');
      if (href) {
        try {
          const resolved = new URL(href, location.href);
          if (['http:', 'https:', 'mailto:'].includes(resolved.protocol)) {
            safe.setAttribute('href', href);
            safe.setAttribute('rel', 'noopener noreferrer');
            if (original.getAttribute('target') === '_blank') safe.setAttribute('target', '_blank');
          }
        } catch { /* Invalid links remain plain text. */ }
      }
    }
    parent.appendChild(safe);
    stack.push(safe);
    parent = safe;
  }
  parent.appendChild(document.createTextNode(text.slice(offset)));
  return fragment;
}
