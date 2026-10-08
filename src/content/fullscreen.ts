/** Native fullscreen and CSS-based video/stream "web fullscreen". */
function isFullscreen(): boolean {
  const legacyDocument = document as Document & { webkitFullscreenElement?: Element | null };
  if (document.fullscreenElement || legacyDocument.webkitFullscreenElement) return true;

  const width = window.innerWidth;
  const height = window.innerHeight;
  if (!width || !height) return false;
  const tolerance = Math.max(4, Math.min(width, height) * 0.02);
  // inset: 0 follows the layout viewport; 100vw can include the scrollbar.
  const coversViewport = (rect: DOMRect): boolean =>
    Math.abs(rect.left) <= tolerance && Math.abs(rect.top) <= tolerance &&
    Math.min(Math.abs(rect.right - width), Math.abs(rect.right - document.documentElement.clientWidth)) <= tolerance &&
    Math.min(Math.abs(rect.bottom - height), Math.abs(rect.bottom - document.documentElement.clientHeight)) <= tolerance;
  const scrollLocked = [document.documentElement, document.body].some(element => {
    const style = getComputedStyle(element);
    return ['hidden', 'clip'].includes(style.overflowX) && ['hidden', 'clip'].includes(style.overflowY);
  });

  // An iframe can host a cross-origin player. Inspect its outer geometry only.
  for (const media of document.querySelectorAll('video, iframe, embed, object')) {
    const rect = media.getBoundingClientRect();
    const style = getComputedStyle(media);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    // Ignore inline thumbnails and hidden/off-screen players. Letterboxed
    // players still qualify when their surrounding overlay fills the viewport.
    const visibleWidth = Math.max(0, Math.min(rect.right, width) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, height) - Math.max(rect.top, 0));
    if (visibleWidth * visibleHeight < width * height * 0.4) continue;

    for (let container: Element | null = media; container && container !== document.body && container !== document.documentElement; container = container.parentElement) {
      if (!coversViewport(container.getBoundingClientRect())) continue;
      const position = getComputedStyle(container).position;
      if (position === 'fixed' || (position === 'absolute' && scrollLocked)) return true;
    }
  }
  return false;
}

export function watchFullscreen(onChange: (fullscreen: boolean) => void): void {
  let previous: boolean | undefined;
  let scheduled = false;
  function update(): void {
    scheduled = false;
    const fullscreen = isFullscreen();
    if (fullscreen === previous) return;
    previous = fullscreen;
    onChange(fullscreen);
  }
  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(update);
  }
  // Native changes must take effect immediately, including a fullscreen iframe.
  document.addEventListener('fullscreenchange', update);
  document.addEventListener('webkitfullscreenchange', update);
  window.addEventListener('resize', schedule);
  window.addEventListener('pageshow', schedule);
  document.addEventListener('transitionend', schedule, true);
  document.addEventListener('animationend', schedule, true);
  new MutationObserver(records => {
    // Our own hide/status/translation changes must not trigger another scan.
    if (records.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return !target?.closest('#mt-controls, #mt-selection, .mt-translation');
    })) schedule();
  }).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'width', 'height']
  });
  update();
}
