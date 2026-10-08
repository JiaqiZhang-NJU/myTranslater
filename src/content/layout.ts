import { ownedTextOf } from './extract';
import type { Role } from '../shared';
import { renderInline, withoutInlineMarkers } from '../inline';
import { closestComposed, containsComposed, hiddenComposed, parentElement, composedParent, renderedChildren, OWNED_SELECTOR } from '../dom';

export type RenderResult = 'inline' | 'floating' | 'failed';
interface Rendered {
  node: Element; carrier: Element; textNodes: Text[]; original: string; text: string;
  role: Role; inline: Map<string, Element>; element: HTMLElement | null; mode: RenderResult;
  watching?: Element[];
}
const rendered = new Map<Element, Rendered>();
const styles = new WeakMap<ShadowRoot, HTMLStyleElement>();
const translationStyle = `
.mt-translation { display:block!important; margin:.25em 0 .7em!important; padding-left:.7em!important; border-left:2px solid #5b7be8!important; color:#3b57a6!important; font:inherit!important; font-size:.94em!important; line-height:1.55!important; white-space:pre-wrap!important; overflow-wrap:anywhere!important; }
.mt-translation[data-mt-contained] { width:max-content!important; max-width:100%!important; margin:.15em 0 0!important; padding-left:.35em!important; color:inherit!important; border-left:2px solid currentColor!important; font-size:.78em!important; line-height:1.25!important; white-space:normal!important; }
.mt-translation[data-mt-compact] { display:inline!important; width:auto!important; margin:0 0 0 .4em!important; padding:0!important; border:0!important; color:inherit!important; font-size:.78em!important; line-height:inherit!important; white-space:normal!important; }
`;
function ensureStyle(node: Element): void {
  const root = node.getRootNode();
  if (root instanceof ShadowRoot) ensureStyleForRoot(root);
}
function ensureStyleForRoot(root: ShadowRoot): void {
  if (styles.get(root)?.isConnected) return;
  const style = document.createElement('style');
  style.setAttribute('data-mt-owned', 'style'); style.textContent = translationStyle;
  root.append(style); styles.set(root, style);
}
const watched = new Map<Element, number>();
const resizeObserver = new ResizeObserver(() => scheduleLayoutCheck());
function watchedElements(record: Rendered): Element[] {
  return [...new Set([record.node, record.carrier, parentElement(record.carrier)].filter((node): node is Element => Boolean(node)))];
}
function watch(record: Rendered, add: boolean): void {
  const elements = add ? (record.watching = watchedElements(record)) : record.watching ?? [];
  for (const element of elements) {
    const count = (watched.get(element) ?? 0) + (add ? 1 : -1);
    if (count > 0) { if (!watched.has(element)) resizeObserver.observe(element); watched.set(element, count); }
    else { resizeObserver.unobserve(element); watched.delete(element); }
  }
}

let panel: HTMLElement | undefined;
let anchor: Element | null = null;
let closeTimer: number | undefined;
let panelTimer: number | undefined;
let displayed: Rendered[] = [];
function closePanel(): void {
  if (panel) panel.hidden = true;
  anchor = null;
  displayed = [];
  if (panelTimer !== undefined) clearInterval(panelTimer);
  panelTimer = undefined;
  if (closeTimer !== undefined) clearTimeout(closeTimer);
  closeTimer = undefined;
}
function panelRoot(): HTMLElement {
  if (panel) return panel;
  panel = document.createElement('section'); panel.id = 'mt-layout-panel'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '受限布局译文'); panel.tabIndex = -1;
  panel.addEventListener('pointerenter', () => { if (closeTimer !== undefined) clearTimeout(closeTimer); });
  panel.addEventListener('pointerleave', () => { closeTimer = window.setTimeout(closePanel, 200); });
  document.documentElement.append(panel);
  return panel;
}
function fillPanel(records: Rendered[], source: Element | null): void {
  const root = panelRoot(); root.replaceChildren();
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭';
  close.addEventListener('click', closePanel); root.append(close);
  if (!records.length) { const empty = document.createElement('p'); empty.textContent = '当前没有使用浮层显示的译文。'; root.append(empty); }
  for (const record of records) {
    const item = document.createElement('div');
    const original = document.createElement('p'); original.className = 'mt-layout-source'; original.textContent = record.original;
    const translation = document.createElement('p'); translation.lang = 'zh-CN'; translation.textContent = withoutInlineMarkers(record.text);
    item.append(original, translation); root.append(item);
  }
  anchor = source; root.hidden = false;
  displayed = records;
  const rect = source?.getBoundingClientRect();
  const width = Math.min(360, Math.max(100, innerWidth - 24));
  root.style.setProperty('width', `${width}px`, 'important');
  const left = rect ? Math.max(12, Math.min(rect.left, innerWidth - width - 12)) : Math.max(12, innerWidth - width - 44);
  root.style.setProperty('left', `${left}px`, 'important');
  const height = root.offsetHeight;
  const top = rect ? (rect.bottom + height + 12 <= innerHeight ? rect.bottom + 6 : Math.max(12, rect.top - height - 6)) : 12;
  root.style.setProperty('top', `${Math.min(top, Math.max(12, innerHeight - height - 12))}px`, 'important');
  if (panelTimer !== undefined) clearInterval(panelTimer);
  panelTimer = window.setInterval(() => {
    if ((anchor && (!anchor.isConnected || hiddenComposed(anchor))) ||
        displayed.some(record => !rendered.has(record.node) || !record.node.isConnected || hiddenComposed(record.node))) closePanel();
  }, 250);
}
export function showRestrictedTranslations(): void {
  fillPanel([...rendered.values()].filter(record => record.mode === 'floating' && record.node.isConnected && !hiddenComposed(record.node)), null);
  panel?.focus();
}
export function restrictedCount(): number { return [...rendered.values()].filter(record => record.mode === 'floating').length; }

function hovered(event: Event): void {
  for (const target of event.composedPath()) {
    if (!(target instanceof Element) || closestComposed(target, OWNED_SELECTOR)) continue;
    const record = rendered.get(target);
    if (record?.mode === 'floating' && !hiddenComposed(record.node)) {
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      if (anchor !== record.node || panel?.hidden) fillPanel([record], record.node);
      return;
    }
  }
}
document.addEventListener('pointerover', hovered, true);
document.addEventListener('focusin', hovered, true);
document.addEventListener('pointerout', event => {
  const next = event.relatedTarget;
  if (next instanceof Node && ((panel && panel.contains(next)) || (anchor && containsComposed(anchor, next)))) return;
  if (anchor) closeTimer = window.setTimeout(closePanel, 200);
}, true);
document.addEventListener('focusout', event => {
  const next = event.relatedTarget;
  if (next instanceof Node && ((panel && panel.contains(next)) || (anchor && containsComposed(anchor, next)))) return;
  if (anchor) closeTimer = window.setTimeout(closePanel, 200);
}, true);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closePanel(); });

function visibleRectInside(rect: DOMRect, bounds: DOMRect, x: boolean, y: boolean): boolean {
  return (!x || (rect.left >= bounds.left - 2 && rect.right <= bounds.right + 2)) &&
    (!y || (rect.top >= bounds.top - 2 && rect.bottom <= bounds.bottom + 2));
}
function unsafe(record: Rendered, previousWidth: number): boolean {
  const translated = record.element!;
  if (hiddenComposed(record.node)) return true;
  if (document.documentElement.scrollWidth > Math.max(previousWidth, document.documentElement.clientWidth) + 2) return true;
  const rect = translated.getBoundingClientRect();
  if (!translated.getClientRects().length || !rect.width || !rect.height) return true;
  for (let element: Element | null = record.carrier; element && element !== document.body; element = parentElement(element)) {
    const style = getComputedStyle(element);
    const clipX = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX);
    const clipY = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY);
    if ((clipX || clipY) && !visibleRectInside(rect, element.getBoundingClientRect(), clipX, clipY)) return true;
    if (['fixed', 'sticky'].includes(style.position) && !visibleRectInside(rect, element.getBoundingClientRect(), true, true)) return true;
    if (element.matches('nav,button,[role="navigation"],[role="menu"],[role="menubar"],[role="tablist"]') &&
        !visibleRectInside(rect, element.getBoundingClientRect(), true, true)) return true;
  }
  if (translated.hasAttribute('data-mt-compact')) {
    const source = record.node.getBoundingClientRect();
    if (!visibleRectInside(rect, source, true, true)) return true;
    for (let source: Element | null = record.node; source && source !== document.body; source = parentElement(source)) {
      const parent = composedParent(source);
      for (const sibling of parent ? renderedChildren(parent) : []) {
        if (!(sibling instanceof Element) || sibling === source || sibling === translated || closestComposed(sibling, OWNED_SELECTOR) || hiddenComposed(sibling)) continue;
        const other = sibling.getBoundingClientRect();
        if (Math.min(rect.right, other.right) - Math.max(rect.left, other.left) > 2 &&
            Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top) > 2) return true;
      }
    }
  }
  return false;
}

function sourceRects(record: Rendered): DOMRect[] {
  return record.textNodes.filter(node => node.textContent?.trim()).flatMap(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    return [...range.getClientRects()];
  });
}
function sourceMoved(before: DOMRect[], after: DOMRect[]): boolean {
  return before.length !== after.length || before.some((rect, i) =>
    Math.abs(rect.left - after[i].left) > 2 || Math.abs(rect.top - after[i].top) > 2 ||
    Math.abs(rect.width - after[i].width) > 2 || Math.abs(rect.height - after[i].height) > 2);
}
function neighboringColumns(record: Rendered): Map<Element, DOMRect> {
  const positions = new Map<Element, DOMRect>();
  for (let parent = parentElement(record.node), depth = 0; parent && parent !== document.body && depth < 5; parent = parentElement(parent), depth++) {
    const style = getComputedStyle(parent);
    if (!style.display.includes('grid') && !(style.display.includes('flex') && style.flexDirection.startsWith('row'))) continue;
    for (const child of renderedChildren(parent)) if (child instanceof Element && !child.matches(OWNED_SELECTOR) && !hiddenComposed(child)) positions.set(child, child.getBoundingClientRect());
  }
  return positions;
}

function insert(record: Rendered): RenderResult {
  if (!record.node.isConnected || !record.carrier.isConnected || !record.textNodes.every(item => item.isConnected) || ownedTextOf(record.textNodes) !== record.original) return 'failed';
  const content = renderInline(record.text, record.inline);
  if (!content) return 'failed';
  const compact = record.role === 'nav' || record.role === 'button' || record.node.matches('summary') ||
    Boolean(closestComposed(record.node, 'nav,[role="navigation"],[role="menu"],[role="menubar"],[role="tablist"]'));
  const contained = compact || ['cell', 'table-header', 'list-item'].includes(record.role) || record.node.matches('label,summary,caption,figcaption');
  ensureStyle(record.carrier);
  const translated = document.createElement(contained ? 'span' : 'div');
  translated.className = 'mt-translation'; translated.lang = 'zh-CN';
  if (contained) translated.setAttribute('data-mt-contained', '');
  if (compact) { translated.setAttribute('data-mt-compact', ''); translated.setAttribute('aria-hidden', 'true'); }
  translated.style.setProperty('visibility', 'hidden', 'important'); translated.append(content);
  const previousWidth = document.documentElement.scrollWidth;
  const before = sourceRects(record);
  const neighbors = neighboringColumns(record);
  if (contained) {
    const list = record.role === 'list-item' ? record.node.querySelector(':scope > ul,:scope > ol') : null;
    if (list && record.carrier === record.node) record.node.insertBefore(translated, list);
    else record.carrier.append(translated);
  } else if (record.node.shadowRoot && record.carrier === record.node && record.textNodes.every(node => node.parentNode === record.node.shadowRoot)) {
    ensureStyleForRoot(record.node.shadowRoot);
    record.node.shadowRoot.append(translated);
  } else if (record.node.assignedSlot || record.node.matches('span') || record.node.shadowRoot || record.node.tagName.includes('-') ||
      /flex|grid/.test(getComputedStyle(parentElement(record.node) ?? record.carrier).display)) record.carrier.append(translated);
  else record.node.insertAdjacentElement('afterend', translated);
  record.element = translated;
  const columnsMoved = [...neighbors].some(([node, previous]) => {
    const current = node.getBoundingClientRect();
    return Math.abs(previous.left - current.left) > 2 || Math.abs(previous.width - current.width) > 2;
  });
  if (unsafe(record, previousWidth) || sourceMoved(before, sourceRects(record)) || columnsMoved) { translated.remove(); record.element = null; return 'floating'; }
  translated.style.removeProperty('visibility');
  return 'inline';
}

export function renderTranslation(node: Element, carrier: Element, textNodes: Text[], original: string, text: string, role: Role, inline: Map<string, Element>): RenderResult {
  clearTranslation(node);
  const record: Rendered = { node, carrier, textNodes, original, text, role, inline, element: null, mode: 'failed' };
  record.mode = insert(record);
  if (record.mode !== 'failed') { rendered.set(node, record); watch(record, true); }
  return record.mode;
}

let scheduled = false;
export function scheduleLayoutCheck(): void {
  if (scheduled || !rendered.size) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    for (const [node, record] of rendered) {
      if (!node.isConnected || ownedTextOf(record.textNodes) !== record.original) { clearTranslation(node); continue; }
      if (record.element) {
        // Global width growth is measured at insertion; existing page overflow
        // must not alternate all records between inline and floating modes.
        if (unsafe(record, document.documentElement.scrollWidth)) { record.element.remove(); record.element = null; record.mode = 'floating'; }
      } else if (!hiddenComposed(node)) record.mode = insert(record);
    }
  });
}
window.addEventListener('resize', () => { closePanel(); scheduleLayoutCheck(); });
document.addEventListener('scroll', event => {
  if (event.target instanceof Node && panel?.contains(event.target)) return;
  closePanel();
}, true);
document.addEventListener('transitionend', scheduleLayoutCheck, true);
export function clearTranslation(node: Element): void {
  const record = rendered.get(node);
  if (record) { record.element?.remove(); watch(record, false); }
  rendered.delete(node);
  if (anchor === node || displayed.some(record => record.node === node)) closePanel();
}
export const closeTranslationPanel = closePanel;
export function clearTranslations(): void {
  for (const record of rendered.values()) record.element?.remove();
  rendered.clear(); resizeObserver.disconnect(); watched.clear(); closePanel();
}
