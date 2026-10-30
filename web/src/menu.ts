/** A non-modal disclosure: normal Tab order, with a radio group for appearance. */
export function setupHeaderMenu() {
  const trigger = document.getElementById('header-menu-button') as HTMLButtonElement | null;
  const panel = document.getElementById('header-menu');
  if (!trigger || !panel) return { close() {}, destroy() {} };
  const cleanups: (() => void)[] = [];
  function listen(target: EventTarget, type: string, listener: EventListener, capture = false) {
    target.addEventListener(type, listener, capture);
    cleanups.push(() => target.removeEventListener(type, listener, capture));
  }
  function close(restoreFocus = false) {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }
  function open() {
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    panel.querySelector<HTMLElement>('button:not([hidden]):not(:disabled), a[href]:not([hidden])')?.focus();
  }
  const inside = (target: EventTarget | null) => !!target &&
    (trigger.contains(target as Node) || panel.contains(target as Node));
  listen(trigger, 'click', () => panel.hidden ? open() : close(true));
  listen(trigger, 'keydown', event => {
    if ((event as KeyboardEvent).key !== 'ArrowDown') return;
    event.preventDefault();
    open();
  });
  listen(document, 'keydown', event => {
    if (panel.hidden || (event as KeyboardEvent).key !== 'Escape') return;
    event.preventDefault();
    close(true);
  });
  listen(document, 'pointerdown', event => { if (!inside(event.target)) close(); });
  listen(document, 'focusin', event => { if (!inside(event.target)) close(); });
  listen(panel, 'click', event => {
    const target = event.target as Element;
    if (target.closest('[data-menu-dismiss]')) close(true);
  }, true);
  listen(window, 'popstate', () => close());
  close();
  trigger.setAttribute('aria-expanded', 'false');
  return { close, destroy() { close(); cleanups.splice(0).forEach(cleanup => cleanup()); } };
}

interface HeaderIdentityState { status: string; ownerPubkey?: string | null; displayName?: string }
interface HeaderIdentityOptions {
  createAvatar: (key: string, options: { size: number }) => HTMLElement;
  createUserName: (key: string) => HTMLElement;
  onProfile: (key: string) => void;
}
/** The same disclosure button shows an avatar after local profile restoration. */
export function setupHeaderIdentity({ createAvatar, createUserName, onProfile }: HeaderIdentityOptions) {
  const signIn = document.getElementById('account-button');
  const trigger = document.getElementById('header-menu-button');
  const profile = document.getElementById('profile-menu');
  if (!signIn || !trigger || !profile) return { render(_state: HeaderIdentityState) {} };
  const visitorIcon = Array.from(trigger.childNodes);
  function render(state: HeaderIdentityState) {
    const owner = state.status === 'ready' ? state.ownerPubkey : null;
    signIn.hidden = !!owner;
    profile.hidden = !owner;
    trigger.classList.toggle('header-account-menu', !!owner);
    if (!owner) {
      trigger.replaceChildren(...visitorIcon);
      profile.replaceChildren();
      profile.onclick = null;
      return;
    }
    trigger.replaceChildren(createAvatar(owner, { size: 28 }));
    const copy = document.createElement('span'), name = createUserName(owner), caption = document.createElement('span');
    copy.className = 'header-profile-copy';
    if (state.displayName) { name.textContent = state.displayName; delete name.dataset.personName; }
    caption.className = 'header-profile-caption';
    caption.textContent = 'View profile';
    copy.append(name, caption);
    profile.replaceChildren(createAvatar(owner, { size: 36 }), copy);
    profile.onclick = () => onProfile(owner);
  }
  return { render };
}
