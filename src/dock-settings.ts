interface Position { origin: string; ratio: number; touched: number }
let serial = Promise.resolve();
const accessed = new Map<string, number>();
let lastTouch = 0;
export async function dockPosition(origin: string, ratio?: number): Promise<number> {
  const operation = serial.then(async () => {
    const raw = (await chrome.storage.local.get('dockPositions')).dockPositions;
    const positions: Position[] = Array.isArray(raw) ? raw.filter(item => item && typeof item.origin === 'string' &&
      /^https?:\/\//.test(item.origin) && Number.isFinite(item.ratio) && item.ratio >= 0 && item.ratio <= 1 && Number.isFinite(item.touched)).slice(0, 200) : [];
    const found = positions.find(item => item.origin === origin);
    if (found || ratio !== undefined) {
      accessed.delete(origin); accessed.set(origin, lastTouch = Math.max(Date.now(), lastTouch + 1));
      if (accessed.size > 200) accessed.delete(accessed.keys().next().value!);
    }
    if (ratio === undefined) return found?.ratio ?? 0.5;
    // Reads touch the in-memory order; persistence happens only at drag/reset.
    const next = [{ origin, ratio, touched: lastTouch }, ...positions.filter(item => item.origin !== origin)
      .map(item => ({ ...item, touched: Math.max(item.touched, accessed.get(item.origin) ?? 0) }))]
      .sort((a, b) => b.touched - a.touched).slice(0, 200);
    await chrome.storage.local.set({ dockPositions: next });
    return ratio;
  });
  serial = operation.then(() => undefined, () => undefined);
  return operation;
}
