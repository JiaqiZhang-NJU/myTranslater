import { visibleText } from './extract';
import type { Role } from '../shared';
import { renderInline } from '../inline';

const rendered = new Map<Element, HTMLElement>();

export function renderTranslation(node: Element, original: string, text: string, role: Role, inline: Map<string, Element>): boolean {
  if (!node.isConnected || visibleText(node) !== original) return false;
  const content = renderInline(text, inline);
  if (!content) return false;
  clearTranslation(node);
  const inlinePlacement = role === 'nav' || role === 'button' || role === 'cell' || role === 'table-header' || role === 'list-item';
  const translated = document.createElement(inlinePlacement ? 'span' : 'div');
  translated.className = 'mt-translation';
  translated.setAttribute('lang', 'zh-CN');
  if (role === 'nav' || role === 'button') translated.setAttribute('aria-hidden', 'true');
  translated.append(content);
  if (inlinePlacement) {
    const nestedList = role === 'list-item' ? node.querySelector(':scope > ul,:scope > ol') : null;
    node.insertBefore(translated, nestedList);
  } else node.insertAdjacentElement('afterend', translated);
  rendered.set(node, translated);
  return true;
}

export function clearTranslation(node: Element): void {
  rendered.get(node)?.remove();
  rendered.delete(node);
}

export function clearTranslations(): void {
  for (const translated of rendered.values()) translated.remove();
  rendered.clear();
}
