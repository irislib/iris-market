import test from 'node:test';
import assert from 'node:assert/strict';
import {readerPreferences, sameLanguage, translationSource, translationSpans} from '../src/translation.ts';

test('device preferences seed the target and additional languages across regional variants', () => {
  assert.deepEqual(readerPreferences({}, ['en-GB', 'fi-FI', 'en-US', 'fi']), {
    auto: false, target: 'en-GB', read: ['fi-FI'],
  });
  assert.deepEqual(readerPreferences({auto: true, read: []}, ['en-US', 'fi']), {
    auto: true, target: 'en-US', read: [],
  });
  assert.deepEqual(readerPreferences({target: 'sv', read: ['fi', 'sv-FI', '??']}, ['en-US']), {
    auto: false, target: 'sv', read: ['fi'],
  });
});

test('confident foreign text qualifies; known languages, unknown results, and uncertain text stay original', () => {
  const choose = (lang, confidence) => translationSource([{detectedLanguage:lang, confidence}], 'en-GB', ['fi-FI']);
  assert.equal(choose('fi', .95), '');
  assert.equal(choose('en-US', .99), '');
  assert.equal(choose('und', 1), '');
  assert.equal(choose('sv', .45), '');
  assert.equal(choose('sv', .99), 'sv');
  assert.equal(sameLanguage('zh-Hant', 'zh-CN'), false);
  assert.equal(sameLanguage('zh-Hant', 'zh-TW'), true);
});

test('literal payment details, URLs, identifiers and amounts never pass through translation', () => {
  const text = 'Nouto 18:30, €19.95. Katso https://example.com/fi/12 tai A52, lnBc12345 ja cashuAabcD.';
  const spans = translationSpans(text);
  assert.equal(spans.map(s => s.text).join(''), text);
  const prose = spans.filter(s => s.prose).map(s => s.text).join('');
  assert.match(prose, /Nouto/);
  assert.doesNotMatch(prose, /18|30|19|95|https|example|A52|cashuA|lnBc/i);
});
