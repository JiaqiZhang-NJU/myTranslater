export type ScanRoot = Element | ShadowRoot;
export const OWNED_SELECTOR = '.mt-translation,[data-mt-owned],#mt-controls,#mt-selection,#mt-layout-panel';

export function composedParent(node: Node): Node | null {
  const slot = (node as Element | Text).assignedSlot;
  return slot ?? node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
}

export function parentElement(node: Node): Element | null {
  const parent = composedParent(node);
  return parent instanceof ShadowRoot ? parent.host : parent instanceof Element ? parent : null;
}

export function closestComposed(node: Node, selector: string): Element | null {
  for (let cursor: Node | null = node; cursor; cursor = composedParent(cursor)) {
    if (cursor instanceof Element && cursor.matches(selector)) return cursor;
  }
  return null;
}

export function containsComposed(root: Node, node: Node): boolean {
  for (let cursor: Node | null = node; cursor; cursor = composedParent(cursor)) if (cursor === root) return true;
  return false;
}

export function renderedChildren(node: Node): Node[] {
  if (node instanceof HTMLSlotElement) return node.assignedNodes({ flatten: true });
  if (node instanceof Element && node.shadowRoot) return [...node.shadowRoot.childNodes];
  return [...node.childNodes];
}

export function* elementsIn(root: Node): Generator<Element> {
  const stack: Node[] = [root];
  const seen = new Set<Node>();
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node instanceof Element) {
      if (node.matches(OWNED_SELECTOR)) continue;
      yield node;
    }
    stack.push(...renderedChildren(node).reverse());
  }
}

export function queryComposed(root: Node, selector: string): Element[] {
  return [...elementsIn(root)].filter(element => element.matches(selector));
}

export function editableComposed(element: Element): boolean {
  // Assigned nodes also inherit editing restrictions from their DOM ancestors.
  const visited = new Set<Element>();
  const check = (start: Element | null, next: (node: Element) => Element | null): boolean => {
    for (let node = start; node; node = next(node)) {
      if (visited.has(node)) continue;
      visited.add(node);
      const value = node.getAttribute('contenteditable')?.trim().toLowerCase();
      if (value !== undefined && value !== 'false' && value !== 'inherit') return true;
    }
    return false;
  };
  return check(element, parentElement) || check(element.parentElement, node => node.parentElement);
}

export function hiddenComposed(element: Element, cache = new Map<Element, boolean>()): boolean {
  for (let cursor: Element | null = element; cursor; cursor = parentElement(cursor)) {
    let hidden = cache.get(cursor);
    if (hidden === undefined) {
      const style = getComputedStyle(cursor);
      hidden = cursor.hasAttribute('hidden') || cursor.getAttribute('aria-hidden') === 'true' ||
        style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0';
      cache.set(cursor, hidden);
    }
    if (hidden) return true;
    if (cursor instanceof HTMLDetailsElement && !cursor.open) {
      const summary = cursor.querySelector(':scope > summary');
      if (element !== cursor && (!summary || !containsComposed(summary, element))) return true;
    }
  }
  return false;
}
