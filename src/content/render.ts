import { ownedTextOf } from './extract';
import type { Role } from '../shared';
import { renderInline } from '../inline';

const rendered = new Map<Element, HTMLElement>();

export function renderTranslation(node: Element, carrier: Element, textNodes: Text[], original: string, text: string, role: Role, inline: Map<string, Element>): boolean {
  if (!node.isConnected || !carrier.isConnected) return false;
  if (!textNodes.every(item => item.isConnected) || ownedTextOf(textNodes) !== original) return false;
  const content = renderInline(text, inline);
  if (!content) return false;
  clearTranslation(node);
  // Labels, summaries and captions keep their translation attached to the
  // element so toggling or clicking the control still shows the text.
  const inlinePlacement = role === 'nav' || role === 'button' || role === 'cell' || role === 'table-header' || role === 'list-item'
    || node.matches('label,summary,caption,figcaption');
  const translated = document.createElement(inlinePlacement ? 'span' : 'div');
  translated.className = 'mt-translation';
  translated.setAttribute('lang', 'zh-CN');
  if (role === 'nav' || role === 'button') translated.setAttribute('aria-hidden', 'true');
  translated.append(content);
  if (inlinePlacement) {
    const nestedList = role === 'list-item' ? node.querySelector(':scope > ul,:scope > ol') : null;
    if (nestedList && carrier === node) node.insertBefore(translated, nestedList);
    else carrier.append(translated);
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
