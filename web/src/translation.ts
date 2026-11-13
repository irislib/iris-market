import {flushSync, mount} from 'svelte';
import {element} from './dom.ts';
import Settings from './ai-view/TranslationSettings.svelte';

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
type Pair = {sourceLanguage: string; targetLanguage: string};
type Detector = {detect(text: string): Promise<{detectedLanguage: string; confidence: number}[]>};
type Translator = {translate(text: string): Promise<string>; destroy(): void};
type BrowserModels = {
  LanguageDetector?: {availability(): Promise<Availability>; create(): Promise<Detector>};
  Translator?: {availability(pair: Pair): Promise<Availability>; create(pair: Pair): Promise<Translator>};
};

const preferenceKey = 'market-translation-v1';
type Preferences = {auto: boolean; target: string; read?: string[]};
const changes = new EventTarget();
const models = () => globalThis as BrowserModels;
let detector: Promise<Detector> | undefined;
function getDetector() {
  return detector ??= models().LanguageDetector.create().then(ready => {
    changes.dispatchEvent(new Event('modelsready'));
    return ready;
  }).catch(error => { detector = undefined; throw error; });
}

function canonical(value: unknown): string {
  if (typeof value !== 'string' || !value || value === 'und') return '';
  try { return Intl.getCanonicalLocales(value)[0] } catch { return '' }
}

// Regional spelling differences don't require translation. Preserve distinct writing systems.
export function sameLanguage(first: string, second: string): boolean {
  if (!canonical(first) || !canonical(second)) return false;
  const a = new Intl.Locale(first).maximize(), b = new Intl.Locale(second).maximize();
  return a.language === b.language && a.script === b.script;
}

export function readerPreferences(stored: Partial<Preferences>, languages: readonly string[]) {
  const preferred = languages.map(canonical).filter(Boolean);
  const target = canonical(stored?.target) || preferred[0] || 'en';
  const read: string[] = [];
  for (const raw of Array.isArray(stored?.read) ? stored.read : preferred) {
    const code = canonical(raw);
    if (code && !sameLanguage(code, target) && !read.some(other => sameLanguage(code, other))) read.push(code);
  }
  return {auto: stored?.auto === true, target, read};
}
function load(): Preferences {
  if (typeof window === 'undefined') return {} as Preferences;
  try { return JSON.parse(window.localStorage.getItem(preferenceKey)) || {} } catch { return {} as Preferences }
}
let preferences = load();
function current() { return readerPreferences(preferences, navigator.languages?.length ? navigator.languages : [navigator.language]); }
function update(change: Partial<Preferences>) {
  preferences = {...preferences, ...change};
  try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch { /* Keep session preferences. */ }
  changes.dispatchEvent(new Event('change'));
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === preferenceKey || event.key === null) { preferences = load(); changes.dispatchEvent(new Event('change')); }
  });
  window.addEventListener('languagechange', () => changes.dispatchEvent(new Event('change')));
}

const languageCodes = 'af am ar as az be bg bn bs ca cs cy da de el en es et eu fa fi fil fr ga gl gu ha he hi hr ht hu hy id ig is it ja ka kk km kn ko ky la lb lo lt lv mg mi mk ml mn mr ms mt my nb ne nl nn or pa pl ps pt ro ru si sk sl so sq sr-Cyrl sr-Latn sv sw ta te th tr uk ur uz vi yi yo yue zh-Hans zh-Hant zu'.split(' ');
function languageName(code: string) {
  return new Intl.DisplayNames(navigator.languages, {type: 'language'}).of(code) || code;
}
/** What the translation settings show; recomputed after each preference change. */
export function translationSettingsView() {
  const prefs = current(), languages = navigator.languages;
  const all = [...new Set([...languageCodes, ...languages, prefs.target, ...prefs.read].map(canonical).filter(Boolean))];
  const sorted = all.map(code => ({code, name: languageName(code)})).sort((a,b) => a.name.localeCompare(b.name));
  return {
    auto: prefs.auto,
    target: canonical(preferences.target),
    deviceLabel: languageName(new Intl.Locale(languages[0] || navigator.language).language) + ' (device)',
    targets: sorted,
    readable: sorted.filter(({code}) => ![prefs.target, ...prefs.read].some(other => sameLanguage(code, other))),
    read: prefs.read.map(code => ({code, name: languageName(code)})),
    supported: !!models().Translator && !!models().LanguageDetector,
  };
}
export function setAutoTranslate(auto: boolean) {
  if (auto && models().LanguageDetector?.create && models().Translator &&
      new URLSearchParams(location.search).get('preview') !== '1') {
    // First-use downloads can require a gesture. Later failures stay recoverable at the item.
    void getDetector().catch(() => {});
  }
  update({auto});
}
export const setTranslationTarget = (target: string) => update({target});
export function addReadLanguage(code: string) { if (code) update({read: [...current().read, code]}); }
export const removeReadLanguage = (code: string) => update({read: current().read.filter(other => !sameLanguage(code, other))});
export function onTranslationPreferences(listener: () => void) {
  changes.addEventListener('change', listener);
  return () => changes.removeEventListener('change', listener);
}
export function translationSettings(): HTMLElement {
  const host = document.createElement('div');
  // The settings page belongs to the app shell for its lifetime.
  mount(Settings, {target: host});
  flushSync();
  const box = host.firstElementChild as HTMLElement;
  box.remove();
  return box;
}

// Keep addresses, invoices, links, amounts, and product codes literal even in unstructured chat.
const literal = /([\r\n]+|(?:www\.|(?:nprofile1|nevent1|note1))\S+|https?:\/\/[^\s]+|(?:cashu[AB]|lnbc|lntb|lnbcrt|lnurl1|npub1|nsec1|naddr1|bc1|nostr:|bitcoin:|lightning:)\S+|[\w.+-]+@[\w.-]+\.[\w-]+|[#@][\p{L}\d_]+|[\p{Sc}]?\b[\p{L}\d_-]*\d[\p{L}\d_-]*(?:[.,:/-]\d+)*\b(?:[ \u00a0]?[€£$¥₿%])?)/giu;
export function translationSpans(value: string) {
  return value.split(literal).map((text, index) => ({text, prose: index % 2 === 0 && /\p{L}/u.test(text)}));
}
function sampleText(value: string) {
  return translationSpans(value.slice(0, 4000)).filter(part => part.prose).map(part => part.text).join(' ').trim();
}
export function translationSource(results: {detectedLanguage: string; confidence: number}[], target: string, read: string[]) {
  const best = results[0];
  const code = canonical(best?.detectedLanguage);
  if (!code || !(best.confidence >= 0.80) || [target, ...read].some(other => sameLanguage(code, other))) return '';
  return code;
}
async function translateFields(values: readonly string[], translator: Translator, signal: AbortSignal) {
  const result: string[] = [];
  for (const value of values) {
    const output: string[] = [];
    for (const {text, prose} of translationSpans(value)) {
      signal.throwIfAborted();
      if (!prose) { output.push(text); continue; }
      const trimmed = text.trim(), translated = await translator.translate(trimmed);
      if (!translated.trim()) throw new Error('Empty translation');
      output.push(text.slice(0, text.indexOf(trimmed)) + translated.trim() + text.slice(text.indexOf(trimmed) + trimmed.length));
    }
    result.push(output.join(''));
  }
  return result;
}

type TranslationHost = HTMLElement & {start?: () => void; stop?: () => void};
function host(): TranslationHost {
  const tag = 'iris-translation';
  if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {
    connectedCallback() { (this as TranslationHost).start?.(); }
    disconnectedCallback() {
      // A receipt can move the same chat bubble to a fresh container in one render.
      queueMicrotask(() => { if (!this.isConnected) (this as TranslationHost).stop?.(); });
    }
  });
  return document.createElement(tag);
}

export function translationFields(values: readonly string[], render: (values: readonly string[]) => void, options: {sample?: string} = {}): HTMLElement {
  const api = models();
  const sample = sampleText(options.sample || values.join(' '));
  const words = sample.match(/\p{L}+/gu) || [];
  const briefLabel = words.length < 2 && words.join('').length < 12 && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(sample);
  if (!api.Translator?.availability || !api.LanguageDetector?.availability || !words.length || briefLabel) {
    const empty = element('span'); empty.hidden = true; return empty;
  }
  const control = host();
  control.className = 'translation-control'; control.hidden = true;
  const action = element('button', undefined, 'text-button');
  action.type = 'button';
  const always = element('button', 'Always translate', 'text-button'); always.type = 'button'; always.hidden = true;
  control.append(action, always);
  let observer: IntersectionObserver, visible = false, originalSelected = false, showing = false;
  let run: AbortController;
  let translated: string[] | undefined;
  let waitingForModel = false;

  function button(label: string, disabled = false) {
    control.hidden = false; action.hidden = false; action.disabled = disabled; action.textContent = label;
    always.hidden = !showing || current().auto;
  }
  function display(visibleTranslation: boolean) {
    render(visibleTranslation ? translated : values); showing = visibleTranslation;
    button(showing ? 'Show original' : 'Translate');
  }
  async function check(manual: boolean) {
    run?.abort(); run = new AbortController();
    waitingForModel = false;
    const signal = run.signal, prefs = current();
    const downloadsAllowed = new URLSearchParams(location.search).get('preview') !== '1';
    const available = api.LanguageDetector, model = api.Translator;
    if (manual) button('Preparing…', true);
    try {
      const detection = await available.availability();
      signal.throwIfAborted();
      if (detection === 'unavailable' || (!downloadsAllowed && detection !== 'available')) { control.hidden = true; return; }
      if (!detector && detection !== 'available' && !manual) {
        waitingForModel = true; button('Check language'); return;
      }
      const recognizer = await getDetector();
      signal.throwIfAborted();
      const source = translationSource(await recognizer.detect(sample), prefs.target, prefs.read);
      signal.throwIfAborted();
      if (!source) { control.hidden = true; return; }
      // Regional device locales may have only a base-language translation model.
      const locale = new Intl.Locale(prefs.target), target = locale.script ? locale.language + '-' + locale.script : locale.language;
      let pair = {sourceLanguage: source, targetLanguage: prefs.target};
      let readiness = await model.availability(pair);
      if (readiness === 'unavailable' && target !== prefs.target) {
        pair = {...pair, targetLanguage: target}; readiness = await model.availability(pair);
      }
      signal.throwIfAborted();
      if (readiness === 'unavailable' || (!downloadsAllowed && readiness !== 'available')) { control.hidden = true; return; }
      if (!manual && (!prefs.auto || readiness !== 'available' || originalSelected)) {
        waitingForModel = readiness !== 'available';
        button(readiness === 'available' ? 'Translate' : 'Download translation'); return;
      }
      button('Translating…', true);
      const session = await model.create(pair);
      try {
        const result = await translateFields(values, session, signal);
        signal.throwIfAborted();
        translated = result; display(true);
        if (readiness !== 'available') changes.dispatchEvent(new Event('modelsready'));
      } finally { session.destroy(); }
    } catch {
      if (!signal.aborted) {
        if (manual || prefs.auto) button('Retry translation');
        else control.hidden = true;
      }
    }
  }
  action.onclick = event => {
    event.preventDefault(); event.stopPropagation();
    if (showing) { originalSelected = true; display(false); }
    else if (translated) { originalSelected = false; display(true); }
    else { originalSelected = false; void check(true); }
  };
  always.onclick = event => { event.preventDefault(); event.stopPropagation(); update({auto: true}); };
  function reset() {
    run?.abort();
    if (showing) render(values);
    translated = undefined; originalSelected = false; showing = false; control.hidden = true;
  }
  function changed() { reset(); if (visible) void check(false); }
  function modelReady() { if (waitingForModel && visible) void check(false); }
  control.start = () => {
    changes.addEventListener('change', changed);
    changes.addEventListener('modelsready', modelReady);
    observer?.disconnect();
    observer = new IntersectionObserver(entries => {
      const entered = entries[entries.length - 1].isIntersecting;
      if (entered && !visible && !showing && !originalSelected) void check(false);
      visible = entered;
    });
    observer.observe(control.parentElement);
  };
  control.stop = () => {
    observer?.disconnect(); changes.removeEventListener('change', changed);
    changes.removeEventListener('modelsready', modelReady); visible = false; reset();
  };
  return control;
}
