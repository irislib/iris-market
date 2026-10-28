import { matchFilters, verifyEvent } from 'nostr-tools';

const MAX_FRAME = 256 * 1024;
const MAX_QUERY_EVENTS = 1024;
const MAX_QUERY_BYTES = 4 * 1024 * 1024;
const hex = /^[0-9a-f]{64}$/;

export function privateRelayUrls(values) {
  const result = [...new Set(values.map(value => {
    const url = new URL(value);
    if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid message server.');
    if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Message servers require a secure connection.');
    return url.toString();
  }))];
  if (!result.length || result.length > 8) throw new Error('Choose between one and eight message servers.');
  return result;
}

export function verifiedPrivateEvent(raw) {
  try {
    const event = { id: raw.id, pubkey: raw.pubkey, created_at: raw.created_at, kind: raw.kind,
      content: raw.content, tags: raw.tags.map(tag => [...tag]), sig: raw.sig };
    if (JSON.stringify(event).length > MAX_FRAME || !verifyEvent(event)) return null;
    return event;
  } catch { return null; }
}

function validateFilters(filters) {
  if (!Array.isArray(filters) || !filters.length || filters.length > 8) throw new Error('Invalid message request.');
  for (const filter of filters) {
    // Public authorization and contact discovery must use one author's scope.
    if (filter.kinds?.some(kind => [37368, 30078].includes(kind)) &&
        (filter.authors?.length !== 1 || !hex.test(filter.authors[0]) || filter['#p'])) {
      throw new Error('Contact discovery requires one author.');
    }
    if (filter.authors && (!filter.authors.length || filter.authors.length > 256 || !filter.authors.every(key => hex.test(key)))) throw new Error('Invalid message authors.');
  }
  return structuredClone(filters);
}

/** Every discovery/inbox subscription has separate anonymous connections; publishing never reuses them. */
export function createPrivateTransport(getRelays, { WebSocketImpl = globalThis.WebSocket } = {}) {
  const active = new Set();
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error('Messages are closed.'); };
  const sockets = (filters, options, handlers, reconnect) => {
    assertOpen();
    const urls = privateRelayUrls(options.relays ?? getRelays());
    const id = crypto.randomUUID();
    const states = urls.map(url => ({ id: url, complete: false, socket: null, timer: null, tries: 0 }));
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      options.signal?.removeEventListener('abort', stop);
      for (const state of states) {
        clearTimeout(state.timer);
        const socket = state.socket;
        if (socket?.readyState === 1) { try { socket.send(JSON.stringify(['CLOSE', id])); } catch {} }
        try { socket?.close(); } catch {}
      }
      active.delete(stop);
    };
    active.add(stop);
    options.signal?.addEventListener('abort', stop, { once: true });
    const connect = state => {
      if (stopped || options.signal?.aborted) return stop();
      let socket;
      try { socket = new WebSocketImpl(state.id); state.socket = socket; }
      catch { return lost(state); }
      socket.addEventListener('open', () => {
        if (stopped) return socket.close();
        state.tries = 0;
        socket.send(JSON.stringify(['REQ', id, ...filters]));
      });
      socket.addEventListener('message', incoming => {
        if (stopped || typeof incoming.data !== 'string' || incoming.data.length > MAX_FRAME) return;
        try {
          const frame = JSON.parse(incoming.data);
          if (frame[0] === 'EOSE' && frame[1] === id) { state.complete = true; handlers.onEose?.(states); }
          if (frame[0] === 'EVENT' && frame[1] === id) {
            const event = verifiedPrivateEvent(frame[2]);
            if (event && matchFilters(filters, event)) handlers.onEvent(event);
          }
          // AUTH is deliberately never answered with the public account key.
        } catch {}
      });
      socket.addEventListener('close', () => lost(state));
      socket.addEventListener('error', () => { try { socket.close(); } catch {} });
    };
    const lost = state => {
      if (stopped) return;
      handlers.onClose?.(states);
      if (reconnect) state.timer = setTimeout(() => connect(state), Math.min(30_000, 1000 * 2 ** Math.min(state.tries++, 5)));
    };
    for (const state of states) connect(state);
    return { close: stop, states };
  };
  return {
    subscribe(filters, handlers, options = {}) {
      if (active.size > 128) throw new Error('Too many open message requests.');
      return sockets(validateFilters(filters), options, handlers, true);
    },
    query(filters, options = {}) {
      const checked = validateFilters(filters);
      return new Promise((resolve, reject) => {
        if (options.signal?.aborted) return reject(options.signal.reason ?? new Error('Request cancelled.'));
        let handle, timer, grace, done = false, bytes = 0;
        const events = new Map();
        const finish = error => {
          if (done) return;
          done = true;
          clearTimeout(timer); clearTimeout(grace);
          options.signal?.removeEventListener('abort', abort);
          handle?.close();
          if (error) reject(error);
          else resolve({ events: [...events.values()], complete: handle.states.every(state => state.complete),
            sources: handle.states.map(({ id, complete }) => ({ id, complete })) });
        };
        const abort = () => finish(options.signal.reason ?? new Error('Request cancelled.'));
        options.signal?.addEventListener('abort', abort, { once: true });
        try {
          handle = sockets(checked, options, {
            onEvent: event => {
              if (events.has(event.id)) return;
              bytes += JSON.stringify(event).length;
              if (events.size >= MAX_QUERY_EVENTS || bytes > MAX_QUERY_BYTES) return finish(new Error('Message request is too large.'));
              events.set(event.id, event);
            },
            onEose: states => {
              if (states.every(state => state.complete)) finish();
              else if (!grace) grace = setTimeout(() => finish(), 500);
            },
          }, false);
          timer = setTimeout(() => finish(), Math.max(1, Math.min(10_000, (options.deadline ?? Date.now() + 6000) - Date.now())));
        } catch (error) { finish(error); }
      });
    },
    async publish(raw, options = {}) {
      assertOpen();
      const event = verifiedPrivateEvent(raw);
      if (!event) throw new Error('Cannot publish an invalid signed message.');
      const urls = privateRelayUrls(options.relays ?? getRelays());
      const accepted = await Promise.all(urls.map(url => new Promise(resolve => {
        let socket, timer, done = false;
        const finish = value => {
          if (done) return;
          done = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); active.delete(abort);
          try { socket?.close(); } catch {}
          resolve(value);
        };
        const abort = () => finish(false);
        if (options.signal?.aborted) return finish(false);
        active.add(abort); options.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(false), options.timeoutMs ?? 6000);
        try {
          socket = new WebSocketImpl(url);
          socket.addEventListener('open', () => { if (!done) socket.send(JSON.stringify(['EVENT', event])); });
          socket.addEventListener('message', incoming => {
            if (typeof incoming.data !== 'string' || incoming.data.length > 4096) return;
            try { const frame = JSON.parse(incoming.data); if (frame[0] === 'OK' && frame[1] === event.id) finish(frame[2] === true); } catch {}
          });
          socket.addEventListener('close', () => finish(false));
          socket.addEventListener('error', () => finish(false));
        } catch { finish(false); }
      })));
      return { remoteAccepted: accepted.some(Boolean), sources: urls.map((id, index) => ({ id, accepted: accepted[index] })) };
    },
    close() { closed = true; for (const stop of [...active]) stop(); },
  };
}
