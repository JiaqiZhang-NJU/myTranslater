import type { Role, TextBlock, TextGroup } from '../shared';
import { extractInline } from '../inline';

export interface PageGroup {
  group: TextGroup;
  nodes: Map<string, Element>;
  sources: Map<string, string>;
  revisions: Map<string, number>;
  inline: Map<string, Map<string, Element>>;
  fingerprint: string;
  top: number;
}

const blocked = 'script,style,noscript,pre,code,textarea,input,select,[contenteditable],[translate="no"],[aria-hidden="true"],[hidden],template,.mt-translation,#mt-controls';
const selector = 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,nav a,[role="navigation"] a,footer a,button,table th,table td';
const ids = new WeakMap<Element, number>();
const revisions = new WeakMap<Element, { source: string; number: number }>();
let nextId = 0;

function identity(element: Element): number {
  let id = ids.get(element);
  if (id === undefined) { id = ++nextId; ids.set(element, id); }
  return id;
}

export function normalizeText(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export function visibleText(element: Element): string {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(blocked)) return NodeFilter.FILTER_REJECT;
      if (element.matches('li,td,th') && parent.closest(element.matches('li') ? 'li' : 'td,th') !== element) return NodeFilter.FILTER_REJECT;
      let current: Element | null = parent;
      while (current && current !== element.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        current = current.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const parts: string[] = [];
  while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '');
  return normalizeText(parts.join(''));
}

function eligible(element: Element): boolean {
  if (element.closest(blocked)) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function role(element: Element): Role {
  if (element.matches('th')) return 'table-header';
  if (element.matches('td')) return 'cell';
  if (element.matches('button')) return 'button';
  if (element.matches('a')) return 'nav';
  if (element.matches('li,dt,dd')) return 'list-item';
  return /^H[1-6]$/.test(element.tagName) ? 'heading' : 'paragraph';
}

function sectionFor(element: Element): string | undefined {
  const area = element.closest('article,section,main') ?? document.body;
  let cursor: Element | null = element;
  while (cursor && cursor !== area) {
    let sibling = cursor.previousElementSibling;
    while (sibling) {
      const heading = sibling.matches('h1,h2,h3,h4,h5,h6') ? sibling : sibling.querySelector('h1,h2,h3,h4,h5,h6');
      if (heading && eligible(heading)) return visibleText(heading).slice(0, 180) || undefined;
      sibling = sibling.previousElementSibling;
    }
    cursor = cursor.parentElement;
  }
  return undefined;
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

function candidates(root: Element): Element[] {
  const found = root.matches(selector) ? [root, ...root.querySelectorAll(selector)] : [...root.querySelectorAll(selector)];
  return found.filter(element => {
    if (!eligible(element)) return false;
    if (element.matches('li') && (element.querySelector('p,h1,h2,h3,h4,h5,h6,button') || (element.closest('nav,[role="navigation"],footer') && element.querySelector('a')))) return false;
    if (element.matches('a') && element.closest('p,h1,h2,h3,h4,h5,h6,td,th,button')) return false;
    if (element.matches('button') && element.closest('td,th')) return false;
    if (element.matches('td,th')) {
      const table = element.closest('table');
      if (!table || !supportedTable(table as HTMLTableElement) || element.querySelector('button,input,select,textarea,table')) return false;
    }
    return true;
  });
}

export function extractPage(root: Element = document.body): PageGroup[] {
  const elements = candidates(root);
  const selected = new Set(elements);
  const consumed = new Set<Element>();
  const groups: PageGroup[] = [];

  function add(container: Element, entries: { element: Element; context?: string }[], section?: string, suffix = ''): void {
    const blocks: TextBlock[] = [];
    const nodes = new Map<string, Element>();
    const sources = new Map<string, string>();
    const versions = new Map<string, number>();
    const inline = new Map<string, Map<string, Element>>();
    const signatures: string[] = [];
    for (const { element, context } of entries) {
      const source = visibleText(element);
      const rich = extractInline(element);
      const text = rich.text;
      if (text.length < 2 || text.length > 2200) continue;
      if (element.matches('td') && /^[\d\s,.:/%+−–$€¥()]+$/u.test(source)) continue;
      const id = `b${identity(element)}`;
      const previous = revisions.get(element);
      const revisionSource = `${source}\0${rich.signature}`;
      const revision = previous?.source === revisionSource ? previous.number : (previous?.number ?? 0) + 1;
      revisions.set(element, { source: revisionSource, number: revision });
      blocks.push({ id, role: role(element), text, ...(context ? { context: context.slice(0, 120) } : {}) });
      nodes.set(id, element);
      sources.set(id, source);
      versions.set(id, revision);
      inline.set(id, rich.elements);
      signatures.push(rich.signature);
    }
    if (!blocks.length) return;
    const group: TextGroup = { id: `g${identity(container)}${suffix}`, ...(section ? { section: section.slice(0, 180) } : {}), blocks };
    groups.push({ group, nodes, sources, revisions: versions, inline, fingerprint: JSON.stringify([group, signatures]), top: entries[0].element.getBoundingClientRect().top });
  }

  for (const element of elements) {
    if (consumed.has(element)) continue;
    const table = element.closest('table') as HTMLTableElement | null;
    if (table && element.matches('td,th')) {
      const row = element.closest('tr') as HTMLTableRowElement;
      const cells = [...row.cells].filter(cell => selected.has(cell));
      cells.forEach(cell => consumed.add(cell));
      const headers = columnHeaders(table);
      const explicit = new Map([...table.querySelectorAll('th[id]')].map(heading => [heading.id, visibleText(heading).slice(0, 60)]));
      const caption = table.caption ? visibleText(table.caption).slice(0, 100) : '';
      const label = [...row.cells].find(cell => cell.tagName === 'TH');
      const rowLabel = label ? visibleText(label).slice(0, 60) : '';
      for (let i = 0; i < cells.length; i += 8) {
        add(row, cells.slice(i, i + 8).map(cell => ({ element: cell, context: cell.tagName === 'TH' ? '' : cellContext(cell, explicit, headers, rowLabel) })), caption || 'Table', `-${i / 8}`);
      }
      continue;
    }
    const nav = element.matches('a') ? element.closest('nav,[role="navigation"],footer') : null;
    if (nav) {
      const links = elements.filter(item => item.matches('a') && item.closest('nav,[role="navigation"],footer') === nav && !consumed.has(item));
      links.forEach(link => consumed.add(link));
      const heading = nav.querySelector('h1,h2,h3,h4,h5,h6');
      const section = heading && eligible(heading) ? visibleText(heading) : nav.matches('footer') ? 'Footer navigation' : 'Site navigation';
      for (let i = 0; i < links.length; i += 8) add(nav, links.slice(i, i + 8).map(link => ({ element: link })), section, `-${i / 8}`);
      continue;
    }
    consumed.add(element);
    if (element.matches('h1,h2,h3,h4,h5,h6')) {
      const next = element.nextElementSibling;
      if (next?.matches('p') && selected.has(next)) {
        consumed.add(next);
        add(element, [{ element }, { element: next }]);
        continue;
      }
    }
    const buttonNav = element.matches('button') && element.closest('nav,[role="navigation"]');
    add(element, [{ element }], role(element) === 'heading' ? undefined : buttonNav ? 'Site navigation control' : sectionFor(element));
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
