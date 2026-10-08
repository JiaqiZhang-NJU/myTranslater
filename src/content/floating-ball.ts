import { watchFullscreen } from './fullscreen';

export interface Controls {
  setActive(active: boolean): void;
  setStatus(text: string): void;
  setRetry(visible: boolean): void;
  setRetryLabel(label: string): void;
  setPaused(paused: boolean): void;
  notify(message: string, durationMs?: number): void;
  setHidden(hidden: boolean): void;
}

export function createControls(onToggle: () => void, onRetry: () => void, onSettings: () => void, onPause: () => void, onHide: () => void): Controls {
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
  panel.append(status, retry, pause, settings);
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
  root.append(ball, panel, menu);
  document.documentElement.append(root);
  let statusText = status.textContent ?? '';
  let noticeTimer: number | undefined;
  function closeMenu(): void { menu.hidden = true; root.classList.remove('mt-menu-open'); }
  watchFullscreen(fullscreen => {
    if (fullscreen) closeMenu();
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
    closeMenu();
    onToggle();
  });
  return {
    setActive(active) {
      ball.title = active ? '恢复原文' : '开始翻译';
      ball.setAttribute('aria-label', ball.title);
      ball.classList.toggle('mt-active', active);
      pause.hidden = !active;
    },
    setStatus(text) { statusText = text; if (noticeTimer === undefined) status.textContent = text; },
    setRetry(visible) { retry.hidden = !visible; },
    setRetryLabel(label) { retry.textContent = label; },
    setPaused(paused) { pause.textContent = paused ? '继续' : '暂停'; },
    notify(message, durationMs = 2800) {
      status.textContent = message;
      root.classList.add('mt-notice');
      if (noticeTimer !== undefined) clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => {
        noticeTimer = undefined;
        root.classList.remove('mt-notice');
        status.textContent = statusText;
      }, durationMs);
    },
    setHidden(hidden) { closeMenu(); root.classList.toggle('mt-hidden', hidden); }
  };
}
