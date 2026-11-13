// A real DOM for component tests. Import before the modules under test.
import {Window} from 'happy-dom'

const window = new Window({url: 'https://market.iris.to/'})
const names = ['window', 'document', 'navigator', 'location', 'history', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement',
  'HTMLDialogElement', 'Text', 'Comment', 'DocumentFragment', 'MouseEvent', 'KeyboardEvent', 'SubmitEvent',
  'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'Option']
for (const name of names) {
  const value = name === 'window' ? window : window[name]
  Object.defineProperty(globalThis, name, {value: typeof value === 'function' && !/^[A-Z]/.test(name) ? value.bind(window) : value, configurable: true, writable: true})
}
// Other DOM classes only where Node has none, so Node's URL, fetch and AbortController stay intact.
for (const name of Object.getOwnPropertyNames(window)) {
  if (/^(?:HTML|SVG)?[A-Z]\w*$/.test(name) && !(name in globalThis) && typeof window[name] === 'function') {
    Object.defineProperty(globalThis, name, {value: window[name], configurable: true, writable: true})
  }
}

export {window}
/** Let Svelte flush effects and pending microtasks. */
export const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
