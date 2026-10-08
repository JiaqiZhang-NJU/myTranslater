import { elementsIn, closestComposed, OWNED_SELECTOR, type ScanRoot } from '../dom';

/** One observer per open tree, plus bounded discovery of late attachShadow(). */
export class RootObserver {
  private observers = new Map<ScanRoot, MutationObserver>();
  private hosts: Element[] = [];
  private customHosts: Element[] = [];
  private knownHosts = new WeakSet<Element>();
  private cursor = 0;
  private customCursor = 0;
  private timer: number;
  private stopped = false;
  constructor(private changed: (records: MutationRecord[]) => void, private discovered: (root: ShadowRoot) => void,
    private slotChanged: (root: ScanRoot) => void,
    private options: MutationObserverInit) {
    this.watch(document.body);
    this.discover(document.body);
    this.timer = window.setInterval(() => this.checkHosts(), 1000);
  }
  private slot = (event: Event): void => {
    const slot = event.target as HTMLSlotElement;
    this.discover(slot);
    this.slotChanged(slot.getRootNode() as ScanRoot);
  };
  private watch(root: ScanRoot): void {
    if (this.observers.has(root) || this.stopped) return;
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && !closestComposed(node, OWNED_SELECTOR)) this.discover(node);
      }
      this.changed(records);
      this.prune();
    });
    observer.observe(root, this.options);
    root.addEventListener('slotchange', this.slot);
    this.observers.set(root, observer);
  }
  discover(scope: Node): void {
    for (const element of elementsIn(scope)) {
      if (!this.knownHosts.has(element)) {
        this.knownHosts.add(element);
        (element.tagName.includes('-') ? this.customHosts : this.hosts).push(element);
      }
      if (element.shadowRoot && !this.observers.has(element.shadowRoot)) {
        this.watch(element.shadowRoot);
        this.discovered(element.shadowRoot);
      }
    }
  }
  private checkHosts(): void {
    this.prune();
    const customCount = Math.min(128, this.customHosts.length);
    for (let i = 0; i < customCount; i++) {
      const element = this.customHosts[this.customCursor++ % this.customHosts.length];
      if (element?.shadowRoot && !this.observers.has(element.shadowRoot)) this.discover(element);
    }
    const count = Math.min(256 - customCount, this.hosts.length);
    for (let i = 0; i < count; i++) {
      const element = this.hosts[this.cursor++ % this.hosts.length];
      if (element?.shadowRoot && !this.observers.has(element.shadowRoot)) this.discover(element);
    }
  }
  private prune(): void {
    for (const [root, observer] of this.observers) {
      if (root instanceof ShadowRoot && !root.host.isConnected) {
        observer.disconnect(); root.removeEventListener('slotchange', this.slot); this.observers.delete(root);
      }
    }
    for (const removed of [...this.hosts, ...this.customHosts].filter(element => !element.isConnected)) this.knownHosts.delete(removed);
    this.hosts = this.hosts.filter(element => element.isConnected);
    this.customHosts = this.customHosts.filter(element => element.isConnected);
  }
  takeRecords(): MutationRecord[] { return [...this.observers.values()].flatMap(observer => observer.takeRecords()); }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const [root, observer] of this.observers) { observer.disconnect(); root.removeEventListener('slotchange', this.slot); }
    this.observers.clear(); this.hosts = []; this.customHosts = [];
  }
}
