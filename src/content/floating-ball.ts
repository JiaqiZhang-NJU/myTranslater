import { watchFullscreen } from './fullscreen';
import { showRestrictedTranslations, closeTranslationPanel } from './render';

export interface Controls {
  setActive(active: boolean): void;
  setStatus(text: string): void;
  setRetry(visible: boolean): void;
  setRetryLabel(label: string): void;
  setPaused(paused: boolean): void;
  notify(message: string, durationMs?: number): void;
  setHidden(hidden: boolean): void;
}

export function createControls(onToggle: () => void, onRetry: () => void, onSettings: () => void, onPause: () => void, onHide: () => void, onRetranslate: () => void = () => {}): Controls {
  const root = document.createElement('div');
  root.id = 'mt-controls';
  const ball = document.createElement('button');
  ball.className = 'mt-ball';
  ball.type = 'button';
  ball.textContent = '译';
  ball.title = '开始翻译';
  ball.setAttribute('aria-label', '开始翻译');
  const panel = document.createElement('div');
  panel.className = 'mt-panel';
  const status = document.createElement('span');
  status.textContent = '点击悬浮球翻译当前页';
  status.setAttribute('role', 'status');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = '重试';
  retry.hidden = true;
  retry.addEventListener('click', onRetry);
  const pause = document.createElement('button');
  pause.type = 'button';
  pause.textContent = '暂停';
  pause.hidden = true;
  pause.addEventListener('click', onPause);
  const settings = document.createElement('button');
  settings.type = 'button';
  settings.textContent = '设置';
  settings.addEventListener('click', onSettings);
  const restricted = document.createElement('button');
  restricted.type = 'button';
  restricted.textContent = '查看受限译文';
  restricted.addEventListener('click', showRestrictedTranslations);
  panel.append(status, retry, pause, settings, restricted);
  const menu = document.createElement('div');
  menu.className = 'mt-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '悬浮球选项');
  menu.hidden = true;
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.setAttribute('role', 'menuitem');
  hide.textContent = '在当前页面隐藏悬浮球';
  hide.addEventListener('click', () => { closeMenu(); onHide(); });
  menu.append(hide);
  const reset = document.createElement('button');
  reset.type = 'button'; reset.setAttribute('role', 'menuitem'); reset.textContent = '重置按钮位置';
  reset.addEventListener('click', () => { closeMenu(); ratio = 0.5; place(); savePosition(); });
  const retranslate = document.createElement('button');
  retranslate.type = 'button'; retranslate.setAttribute('role', 'menuitem'); retranslate.textContent = '重新翻译当前页（重新消耗用量）';
  retranslate.addEventListener('click', () => { closeMenu(); onRetranslate(); });
  menu.append(reset, retranslate);
  root.append(ball, panel, menu);
  document.documentElement.append(root);
  let statusText = status.textContent ?? '';
  let noticeTimer: number | undefined;
  let ratio = 0.5;
  let touched = false;
  let pointer: number | undefined;
  let startX = 0, startY = 0, originY = 0, startRatio = 0.5;
  let moved = false;
  let suppressClick = false;
  let suppressTimer: number | undefined;
  function range(): { min: number; travel: number } {
    return { min: Math.min(8, Math.max(0, (innerHeight - 48) / 2)), travel: Math.max(0, innerHeight - 48 - 16) };
  }
  function place(): void {
    const bounds = range();
    const top = bounds.min + ratio * bounds.travel;
    root.style.setProperty('top', `${top}px`, 'important');
    const height = panel.offsetHeight;
    const panelTop = Math.max(8, Math.min(innerHeight - height - 8, top + 24 - height / 2));
    root.style.setProperty('--mt-panel-y', '0%');
    root.style.setProperty('--mt-panel-top', `${panelTop - top}px`);
  }
  function savePosition(): void {
    touched = true;
    void chrome.runtime.sendMessage({ type: 'SET_DOCK_POSITION', ratio }).catch(() => {});
  }
  void chrome.runtime.sendMessage({ type: 'GET_DOCK_POSITION' }).then(result => {
    if (!touched && pointer === undefined && result?.ok && Number.isFinite(result.ratio)) { ratio = Math.max(0, Math.min(1, result.ratio)); place(); }
  }).catch(() => {});
  function finishDrag(cancelled = false): void {
    if (pointer === undefined) return;
    const id = pointer; pointer = undefined;
    if (ball.hasPointerCapture(id)) ball.releasePointerCapture(id);
    root.classList.remove('mt-dragging');
    if (moved) {
      suppressClick = true;
      if (suppressTimer !== undefined) clearTimeout(suppressTimer);
      suppressTimer = window.setTimeout(() => { suppressClick = false; }, 350);
      if (!cancelled) savePosition();
      else { ratio = startRatio; place(); }
    }
  }
  ball.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointer !== undefined) return;
    pointer = event.pointerId; startX = event.clientX; startY = event.clientY;
    originY = root.getBoundingClientRect().top; startRatio = ratio; moved = false;
    ball.setPointerCapture(event.pointerId);
  });
  ball.addEventListener('pointermove', event => {
    if (event.pointerId !== pointer) return;
    if (!moved && Math.hypot(event.clientX - startX, event.clientY - startY) <= 6) return;
    moved = true; closeMenu(); root.classList.add('mt-dragging');
    const bounds = range();
    ratio = bounds.travel ? Math.max(0, Math.min(1, (originY + event.clientY - startY - bounds.min) / bounds.travel)) : 0.5;
    place();
  });
  ball.addEventListener('pointerup', () => finishDrag());
  ball.addEventListener('pointercancel', () => finishDrag(true));
  ball.addEventListener('lostpointercapture', () => finishDrag(true));
  window.addEventListener('resize', place);
  function closeMenu(): void { menu.hidden = true; root.classList.remove('mt-menu-open'); }
  watchFullscreen(fullscreen => {
    if (fullscreen) { closeMenu(); closeTranslationPanel(); finishDrag(true); }
    root.classList.toggle('mt-fullscreen-hidden', fullscreen);
  });
  ball.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
    menu.hidden = false;
    root.classList.add('mt-menu-open');
    const rect = ball.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    menu.style.top = `${rect.top >= height + 8 ? rect.top - height - 8 : Math.min(rect.bottom + 8, window.innerHeight - height - 8)}px`;
    hide.focus();
  });
  document.addEventListener('pointerdown', event => {
    if (!menu.hidden && !menu.contains(event.target as Node) && event.target !== ball) closeMenu();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { closeMenu(); ball.focus(); }
  });
  ball.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    closeMenu();
    onToggle();
  });
  return {
    setActive(active) {
      ball.title = active ? '恢复原文' : '开始翻译';
      ball.setAttribute('aria-label', ball.title);
      ball.classList.toggle('mt-active', active);
      pause.hidden = !active;
      place();
    },
    setStatus(text) { statusText = text; if (noticeTimer === undefined) status.textContent = text; place(); },
    setRetry(visible) { retry.hidden = !visible; place(); },
    setRetryLabel(label) { retry.textContent = label; place(); },
    setPaused(paused) { pause.textContent = paused ? '继续' : '暂停'; place(); },
    notify(message, durationMs = 2800) {
      status.textContent = message;
      place();
      root.classList.add('mt-notice');
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => {
        noticeTimer = undefined;
        root.classList.remove('mt-notice');
        status.textContent = statusText;
        place();
      }, durationMs);
    },
    setHidden(hidden) { closeMenu(); root.classList.toggle('mt-hidden', hidden); }
  };
}
