/** Page-local values only. Accounting remains correct on replacement/deletion. */
export class PageCache<T> {
  private values = new Map<string, { value: T; size: number }>();
  private chars = 0;
  constructor(private maxEntries: number, private maxChars: number) {}
  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    this.values.delete(key); this.values.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T): void {
    this.delete(key);
    const size = key.length + JSON.stringify(value).length;
    if (size > this.maxChars) return;
    this.values.set(key, { value, size }); this.chars += size;
    while (this.values.size > this.maxEntries || this.chars > this.maxChars) this.delete(this.values.keys().next().value!);
  }
  delete(key: string): void {
    const entry = this.values.get(key);
    if (entry) { this.chars -= entry.size; this.values.delete(key); }
  }
  clear(): void { this.values.clear(); this.chars = 0; }
  get size(): number { return this.values.size; }
}
