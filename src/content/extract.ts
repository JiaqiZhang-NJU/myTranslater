import type { Role, TextBlock, TextGroup } from '../shared';
import { BLOCK_MAX_CHARS, BLOCK_MIN_CHARS } from '../shared';
import { extractInline } from '../inline';

export interface PageGroup {
  group: TextGroup;
  /** The element whose text owns this block; used for identity and revisions. */
  nodes: Map<string, Element>;
  /** The element the translation is inserted into (usually the same node). */
  carriers: Map<string, Element>;
  /** Text nodes owned by the block, so change detection needs no DOM walk. */
  textNodes: Map<string, Text[]>;
  sources: Map<string, string>;
  revisions: Map<string, number>;
  inline: Map<string, Map<string, Element>>;
  fingerprint: string;
  top: number;
}

const HARD_BLOCKED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'PRE', 'CODE', 'TEXTAREA', 'INPUT', 'SELECT', 'TEMPLATE']);
const NAV_SELECTOR = 'nav,[role="navigation"],[role="menu"],[role="menubar"],[role="tablist"],footer';
const DEFINITE_OWNER_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,dt,dd,td,th,label,summary,caption,figcaption,blockquote';
const INTERACTIVE_SELECTOR = 'a,button,[role="button"],[role="switch"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="treeitem"],[role="link"]';
const NAV_ROLE_SELECTOR = '[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="treeitem"],[role="link"]';
const BUTTON_ROLE_SELECTOR = '[role="button"],[role="switch"]';
const GENERIC_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'FIGURE', 'FORM', 'ADDRESS', 'FIELDSET', 'DETAILS', 'DIALOG']);
/**
 * Everything that can own text: the semantic tags plus the plain containers
 * the fallback path needs to see. A container only ever owns text that no
 * nested block already owns, so listing them is safe.
 */
const CANDIDATE_SELECTOR = `h1,h2,h3,h4,h5,h6,p,li,dt,dd,label,summary,caption,figcaption,blockquote,button,th,td,a,div,section,article,aside,header,footer,main,figure,form,address,fieldset,details,dialog,${NAV_ROLE_SELECTOR},${BUTTON_ROLE_SELECTOR}`;
const NAV_HINT = /nav|menu|tab|crumb|breadcrumb|pagination|pager|toolbar|toc/i;
const NAV_TEXT_LIMIT = 600;
const NAV_LABEL_LIMIT = 40;
const NAV_OUTSIDE_LIMIT = 80;
/** Page numbers, ratings and stand-alone badges carry no language to translate. */
const NON_TRANSLATABLE = /^[\s\d\p{P}\p{S}]+$/u;

const ids = new WeakMap<Element, number>();
const revisions = new WeakMap<Element, { source: string; number: number }>();
const navigationCache = new WeakMap<Element, Element | null>();
let nextId = 0;
/** Owners registered by the last extractPage() call; sourceText() walks stop at them. */
let owners = new WeakSet<Element>();
/** Per-scan visibility cache so a large page costs one getComputedStyle per element. */
let visibilityCache = new Map<Element, boolean>();

function identity(element: Element): number {
  let id = ids.get(element);
  if (id === undefined) { id = ++nextId; ids.set(element, id); }
  return id;
}

export function normalizeText(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function blockedElement(element: Element): boolean {
  if (HARD_BLOCKED_TAGS.has(element.tagName)) return true;
  if (element.hasAttribute('hidden') || element.getAttribute('translate') === 'no' || element.getAttribute('aria-hidden') === 'true') return true;
  return element.classList.contains('mt-translation') || element.id === 'mt-controls' || element.id === 'mt-selection';
}

/**
 * An editable region is treated as one opaque area: if any ancestor (or the
 * element itself) declares editable, nothing inside is collected. A nested
 * `contenteditable="false"` island is therefore skipped as well, which keeps
 * the extraction rule and the inline rule identical and avoids injecting
 * translation nodes into live editors. A `contenteditable="false"` element
 * outside any editor is ordinary read-only content and is collected normally.
 */
export function isEditable(element: Element): boolean {
  let node: Element | null = element;
  while (node) {
    const value = node.getAttribute('contenteditable');
    if (value !== null) {
      const normalized = value.trim().toLowerCase();
      if (normalized !== 'false' && normalized !== 'inherit') return true;
    }
    node = node.parentElement;
  }
  return false;
}

export function isHidden(element: Element): boolean {
  const cached = visibilityCache.get(element);
  if (cached !== undefined) return cached;
  const style = getComputedStyle(element);
  const value = style.display === 'none' || style.visibility === 'hidden';
  visibilityCache.set(element, value);
  return value;
}

/** Short numeric badges such as `(34)` stay part of the page, not of the request. */
function isBadge(element: Element): boolean {
  if (!element.matches('sup,sub')) return false;
  const text = normalizeText(element.textContent);
  if (!text || text.length > 16 || !/\d/.test(text)) return false;
  return !/[A-Za-z]{2,}/.test(text) && !/[\u3400-\u9fff]/.test(text);
}

function skippedForText(element: Element): boolean {
  return blockedElement(element) || isBadge(element) || isEditable(element) || isHidden(element);
}

function walkText(element: Element, stop: (node: Element) => boolean): string {
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent ?? ''); return; }
    if (!(node instanceof Element)) return;
    if (node !== element && (skippedForText(node) || stop(node))) return;
    for (const child of node.childNodes) visit(child);
  };
  visit(element);
  return normalizeText(parts.join(''));
}

export function visibleText(element: Element): string {
  return walkText(element, () => false);
}

/** Text owned by a block: descendants owned by a nested block are excluded. */
export function sourceText(element: Element): string {
  return walkText(element, node => owners.has(node));
}

export function ownedTextOf(textNodes: Text[]): string {
  return normalizeText(textNodes.map(node => node.textContent ?? '').join(''));
}

function eligible(element: Element): boolean {
  let node: Element | null = element;
  while (node) {
    if (blockedElement(node)) return false;
    node = node.parentElement;
  }
  if (isEditable(element) || isHidden(element)) return false;
  return element.getClientRects().length > 0;
}

function nearestPrecedingHeading(element: Element): string {
  const area = element.closest('article,section,main') ?? document.body;
  let cursor: Element | null = element;
  while (cursor && cursor !== area) {
    let sibling = cursor.previousElementSibling;
    while (sibling) {
      const heading = sibling.matches('h1,h2,h3,h4,h5,h6') ? sibling : sibling.querySelector('h1,h2,h3,h4,h5,h6');
      if (heading && eligible(heading)) return visibleText(heading).slice(0, 180);
      sibling = sibling.previousElementSibling;
    }
    cursor = cursor.parentElement;
  }
  return '';
}

/**
 * Ordinary `div`/`ul` navigation is not marked with a landmark, so it is
 * recognised from structure: repeated sibling links, short labels, little text
 * outside the links and no long card description. Class names only ever act as
 * a supporting hint.
 */
function genericNavigation(anchor: Element): Element | null {
  let container: Element | null = anchor.parentElement;
  for (let depth = 0; container && depth < 4; depth++, container = container.parentElement) {
    if (container === document.body || container === document.documentElement) break;
    if (container.matches(DEFINITE_OWNER_SELECTOR) || !eligible(container)) break;
    const anchors = [...container.querySelectorAll('a[href],[role="link"]')].filter(item => eligible(item));
    if (anchors.length < 2 || anchors.length > 40) continue;
    let total = 0;
    let labelsValid = true;
    for (const item of anchors) {
      const label = visibleText(item);
      if (!label || label.length > NAV_LABEL_LIMIT) { labelsValid = false; break; }
      total += label.length;
    }
    if (!labelsValid || total > 500) continue;
    const containerText = visibleText(container);
    if (!containerText.length || containerText.length > NAV_TEXT_LIMIT) continue;
    if (containerText.length - total > NAV_OUTSIDE_LIMIT) continue;
    if (!repeatedSlots(container, anchors)) continue;
    return container;
  }
  return null;
}

/** True when the links occupy repeated siblings or repeated wrapper elements. */
function repeatedSlots(container: Element, anchors: Element[]): boolean {
  const anchorSet = new Set(anchors);
  const children = [...container.children].filter(child => !skippedForText(child));
  if (!children.length) return false;
  if (children.every(child => anchorSet.has(child))) return children.length >= 2;
  const signatures = new Set<string>();
  for (const child of children) {
    if (anchorSet.has(child)) { signatures.add('a'); continue; }
    const inner = [...child.querySelectorAll('a[href],[role="link"]')].filter(item => anchorSet.has(item));
    if (inner.length !== 1) return false;
    signatures.add(child.tagName);
  }
  return signatures.size <= 2;
}

export function navigationFor(element: Element): Element | null {
  const cached = navigationCache.get(element);
  if (cached !== undefined && (cached === null || (cached.isConnected && cached.contains(element)))) return cached;
  const semantic = element.closest(NAV_SELECTOR);
  const container = semantic ?? genericNavigation(element);
  navigationCache.set(element, container);
  return container;
}

function navigationSection(nav: Element): string {
  const labelled = nav.getAttribute('aria-label') ?? '';
  const labelledBy = nav.getAttribute('aria-labelledby');
  if (!labelled && labelledBy) {
    const target = document.getElementById(labelledBy.split(/\s+/)[0]);
    if (target && eligible(target)) return visibleText(target).slice(0, 180);
  }
  if (labelled.trim()) return labelled.trim().slice(0, 180);
  const heading = nav.querySelector('h1,h2,h3,h4,h5,h6');
  if (heading && eligible(heading)) return visibleText(heading).slice(0, 180);
  if (nav.matches('footer') || nav.closest('footer')) return 'Footer navigation';
  return nearestPrecedingHeading(nav) || 'Site navigation';
}

const NAV_ROLES = new Set(['tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'link']);
const BUTTON_ROLES = new Set(['button', 'switch']);

function ownerRole(element: Element): Role | null {
  if (!eligible(element)) return null;
  const tag = element.tagName;
  const aria = (element.getAttribute('role') ?? '').trim().toLowerCase();
  if (/^H[1-6]$/.test(tag)) return 'heading';
  if (tag === 'TH') return 'table-header';
  if (tag === 'TD') return 'cell';
  // An explicit ARIA role describes the purpose, so a `role="tab"` button is
  // collected as navigation rather than as a generic control.
  if (NAV_ROLES.has(aria)) return 'nav';
  if (tag === 'BUTTON' || BUTTON_ROLES.has(aria)) return 'button';
  if (tag === 'A') return navigationFor(element) ? 'nav' : null;
  if (tag === 'LI' || tag === 'DT' || tag === 'DD') return 'list-item';
  if (tag === 'P' || tag === 'LABEL' || tag === 'SUMMARY' || tag === 'CAPTION' || tag === 'FIGCAPTION' || tag === 'BLOCKQUOTE') return 'paragraph';
  return null;
}

/**
 * Fallback discovery for plain `div`/`section` text that no semantic rule
 * covers. Containers are excluded, so a wrapper only owns text that its
 * nested blocks do not already own.
 */
function genericOwner(element: Element): boolean {
  if (!GENERIC_TAGS.has(element.tagName) || !eligible(element)) return false;
  if (element.closest(INTERACTIVE_SELECTOR) || element.closest(DEFINITE_OWNER_SELECTOR)) return false;
  const declaredRole = element.getAttribute('role');
  if (declaredRole && declaredRole !== 'none' && declaredRole !== 'presentation') return false;
  return true;
}

function collectOwned(root: Element, ownerSet: WeakSet<Element>): Map<Element, Text[]> {
  const result = new Map<Element, Text[]>();
  const stack: Element[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const owner = stack.at(-1);
      if (owner) {
        const parts = result.get(owner);
        if (parts) parts.push(node as Text); else result.set(owner, [node as Text]);
      }
      return;
    }
    if (!(node instanceof Element)) return;
    if (node !== root && skippedForText(node)) return;
    const pushed = ownerSet.has(node);
    if (pushed) stack.push(node);
    for (const child of node.childNodes) visit(child);
    if (pushed) stack.pop();
  };
  visit(root);
  return result;
}

function roleOf(element: Element, roles: Map<Element, Role>): Role {
  return roles.get(element) ?? 'paragraph';
}

function supportedTable(table: HTMLTableElement): boolean {
  if (table.querySelector('table,[role="grid"]')) return false;
  if (!table.querySelector('th')) return false;
  return [...table.rows].every(row => [...row.cells].every(cell => cell.colSpan === 1 && cell.rowSpan === 1));
}

function columnHeaders(table: HTMLTableElement): string[] {
  const row = table.tHead?.rows[table.tHead.rows.length - 1] ?? table.rows[0];
  if (!row || ![...row.cells].some(cell => cell.tagName === 'TH')) return [];
  return [...row.cells].map(cell => cell.tagName === 'TH' ? visibleText(cell).slice(0, 80) : '');
}

function cellContext(cell: HTMLTableCellElement, explicit: Map<string, string>, columns: string[], rowLabel: string): string {
  const referenced = (cell.getAttribute('headers') ?? '').split(/\s+/).filter(Boolean)
    .map(id => explicit.get(id)).filter((text): text is string => Boolean(text));
  const column = referenced.length ? referenced.join(' / ') : columns[cell.cellIndex];
  return [column && `Column: ${column}`, rowLabel && `Row: ${rowLabel}`].filter(Boolean).join('; ');
}

/**
 * The deepest descendant that carries exactly the same translatable text.
 * For markup such as `<a><div class="title">Matches (34)</div></a>` the
 * translation belongs in the title node, not in a new flex child of the link.
 */
function carrierFor(element: Element, text: string): Element {
  if (!element.matches(INTERACTIVE_SELECTOR)) return element;
  let carrier = element;
  const visit = (node: Element): void => {
    for (const child of node.children) {
      if (!eligible(child) || sourceText(child) !== text) continue;
      carrier = child;
      visit(child);
      return;
    }
  };
  visit(element);
  return carrier;
}

export function extractPage(root: Element = document.body): PageGroup[] {
  owners = new WeakSet<Element>();
  visibilityCache = new Map<Element, boolean>();

  const candidates = root.matches(CANDIDATE_SELECTOR) ? [root, ...root.querySelectorAll(CANDIDATE_SELECTOR)] : [...root.querySelectorAll(CANDIDATE_SELECTOR)];
  const roles = new Map<Element, Role>();
  for (const element of candidates) {
    const declared = ownerRole(element);
    if (declared) { roles.set(element, declared); owners.add(element); continue; }
    if (genericOwner(element)) { roles.set(element, 'paragraph'); owners.add(element); }
  }

  const owned = collectOwned(root, owners);
  const elements = [...roles.keys()].filter(element => (owned.get(element)?.length ?? 0) > 0);
  const selected = new Set(elements);
  const consumed = new Set<Element>();
  const navMembers = new Map<Element, Element[]>();
  for (const element of elements) {
    if (roleOf(element, roles) !== 'nav') continue;
    const nav = navigationFor(element);
    if (!nav) continue;
    const members = navMembers.get(nav);
    if (members) members.push(element); else navMembers.set(nav, [element]);
  }
  const groups: PageGroup[] = [];

  function add(
    container: Element,
    entries: { element: Element; context?: string; inline: ReturnType<typeof extractInline> }[],
    section?: string,
    suffix = ''
  ): void {
    const blocks: TextBlock[] = [];
    const nodes = new Map<string, Element>();
    const carriers = new Map<string, Element>();
    const textNodes = new Map<string, Text[]>();
    const sources = new Map<string, string>();
    const versions = new Map<string, number>();
    const inline = new Map<string, Map<string, Element>>();
    const signatures: string[] = [];
    for (const { element, context, inline: rich } of entries) {
      const ownedNodes = owned.get(element)!;
      const source = ownedTextOf(ownedNodes);
      const text = rich.text;
      if (text.length < BLOCK_MIN_CHARS || text.length > BLOCK_MAX_CHARS) continue;
      if (NON_TRANSLATABLE.test(source)) continue;
      const id = `b${identity(element)}`;
      const previous = revisions.get(element);
      const revisionSource = `${source}\0${rich.signature}`;
      const revision = previous?.source === revisionSource ? previous.number : (previous?.number ?? 0) + 1;
      revisions.set(element, { source: revisionSource, number: revision });
      blocks.push({ id, role: roleOf(element, roles), text, ...(context ? { context: context.slice(0, 120) } : {}) });
      nodes.set(id, element);
      carriers.set(id, carrierFor(element, source));
      textNodes.set(id, ownedNodes);
      sources.set(id, source);
      versions.set(id, revision);
      inline.set(id, rich.elements);
      signatures.push(rich.signature);
    }
    if (!blocks.length) return;
    const group: TextGroup = { id: `g${identity(container)}${suffix}`, ...(section ? { section: section.slice(0, 180) } : {}), blocks };
    groups.push({
      group, nodes, carriers, textNodes, sources, revisions: versions, inline,
      fingerprint: JSON.stringify([group, signatures]),
      top: entries[0].element.getBoundingClientRect().top
    });
  }

  const inlineFor = (element: Element) => extractInline(element, node => owners.has(node) || isBadge(node));

  for (const element of elements) {
    if (consumed.has(element)) continue;
    const kind = roleOf(element, roles);
    const table = element.closest('table') as HTMLTableElement | null;
    if (table && (kind === 'cell' || kind === 'table-header')) {
      const row = element.closest('tr') as HTMLTableRowElement;
      if (!supportedTable(table)) { consumed.add(element); continue; }
      const cells = [...row.cells].filter(cell => selected.has(cell) && !consumed.has(cell));
      cells.forEach(cell => consumed.add(cell));
      const headers = columnHeaders(table);
      const explicit = new Map([...table.querySelectorAll('th[id]')].map(heading => [heading.id, visibleText(heading).slice(0, 60)]));
      const caption = table.caption ? visibleText(table.caption).slice(0, 100) : '';
      const label = [...row.cells].find(cell => cell.tagName === 'TH');
      const rowLabel = label ? visibleText(label).slice(0, 60) : '';
      for (let i = 0; i < cells.length; i += 8) {
        add(row, cells.slice(i, i + 8).map(cell => ({
          element: cell,
          context: cell.tagName === 'TH' ? '' : cellContext(cell, explicit, headers, rowLabel),
          inline: inlineFor(cell)
        })), caption || 'Table', `-${i / 8}`);
      }
      continue;
    }
    const nav = kind === 'nav' ? navigationFor(element) : null;
    if (nav) {
      const links = (navMembers.get(nav) ?? []).filter(item => !consumed.has(item));
      links.forEach(link => consumed.add(link));
      const section = navigationSection(nav);
      const shareSection = nav.matches('nav,footer,[role="navigation"]') && !NAV_HINT.test(`${nav.className} ${nav.id} ${nav.getAttribute('aria-label') ?? ''}`);
      for (let i = 0; i < links.length; i += 8) {
        add(nav, links.slice(i, i + 8).map(link => ({ element: link, context: shareSection ? section : '', inline: inlineFor(link) })), section, `-${i / 8}`);
      }
      continue;
    }
    consumed.add(element);
    if (kind === 'heading') {
      const next = element.nextElementSibling;
      if (next?.matches('p') && selected.has(next) && !consumed.has(next)) {
        consumed.add(next);
        add(element, [{ element, inline: inlineFor(element) }, { element: next, inline: inlineFor(next) }]);
        continue;
      }
      add(element, [{ element, inline: inlineFor(element) }]);
      continue;
    }
    const context = kind === 'paragraph' || kind === 'list-item' ? nearestPrecedingHeading(element) : '';
    add(element, [{ element, context, inline: inlineFor(element) }]);
  }
  return groups;
}

export function prioritize(groups: PageGroup[]): PageGroup[] {
  const height = window.innerHeight;
  return [...groups].sort((a, b) => {
    const score = (top: number) => top < -100 ? Math.abs(top) + height : top > height ? top - height : 0;
    return score(a.top) - score(b.top);
  });
}
