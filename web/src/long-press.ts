/** Adds an options gesture without changing the control's ordinary click action. */
export function setupLongPress(control: HTMLElement, open: () => void, { delay = 500, movement = 10 } = {}) {
  const surface = control.ownerDocument;
  let pointer: { id: number; x: number; y: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suppressClick = false;
  const clearPress = () => { clearTimeout(timer); timer = undefined; pointer = undefined; };
  const clearSuppression = () => { suppressClick = false; };
  const show = () => {
    if (suppressClick) return;
    suppressClick = true;
    open();
  };
  const down = (event: PointerEvent) => {
    clearPress();
    clearSuppression();
    if (event.button !== 0 || event.isPrimary === false) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    timer = setTimeout(() => { timer = undefined; show(); }, delay);
  };
  const move = (event: PointerEvent) => {
    if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > movement) clearPress();
  };
  const end = (event: PointerEvent) => { if (pointer?.id === event.pointerId) clearPress(); };
  const click = (event: MouseEvent) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clearSuppression();
  };
  const context = (event: Event) => { event.preventDefault(); clearPress(); show(); };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault(); clearPress(); clearSuppression(); show();
    } else if (event.key === 'Enter' || event.key === ' ') clearSuppression();
  };
  control.addEventListener('pointerdown', down);
  surface.addEventListener('pointermove', move);
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', end);
  control.addEventListener('click', click, true);
  control.addEventListener('contextmenu', context);
  control.addEventListener('keydown', key);
  return () => {
    clearPress(); clearSuppression();
    control.removeEventListener('pointerdown', down);
    surface.removeEventListener('pointermove', move);
    surface.removeEventListener('pointerup', end);
    surface.removeEventListener('pointercancel', end);
    control.removeEventListener('click', click, true);
    control.removeEventListener('contextmenu', context);
    control.removeEventListener('keydown', key);
  };
}
