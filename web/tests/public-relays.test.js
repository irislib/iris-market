import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RELAYS, DEFAULT_PRIVATE_RELAYS, privateRelaySelection } from '../src/public-relays.ts';

test('new public defaults do not widen private messaging before an explicit relay choice', () => {
  const previous = ['wss://temp.iris.to', 'wss://vault.iris.to', 'wss://relay.damus.io', 'wss://relay.snort.social', 'wss://relay.primal.net', 'wss://nos.lol'];
  assert.deepEqual(DEFAULT_PRIVATE_RELAYS, previous);
  assert(DEFAULT_RELAYS.includes('wss://relay.ditto.pub'));
  assert.deepEqual(privateRelaySelection(DEFAULT_RELAYS, false), previous);
  // Reading or saving unrelated settings does not change the relay selection.
  assert.deepEqual(privateRelaySelection(DEFAULT_RELAYS, false), previous);
  assert.deepEqual(privateRelaySelection(DEFAULT_RELAYS, true), DEFAULT_RELAYS);
});

test('every deliberate relay set applies unchanged to private connections, including empty', () => {
  for (const selection of [[], DEFAULT_PRIVATE_RELAYS, DEFAULT_RELAYS, ['wss://custom.example'], [...DEFAULT_PRIVATE_RELAYS, 'wss://custom.example']]) {
    const actual = privateRelaySelection(selection, true);
    assert.deepEqual(actual, selection);
    assert.notEqual(actual, selection);
  }
});
