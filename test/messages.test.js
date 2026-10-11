import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MESSAGES, testOk, testFailed, reconnectOk, reconnectFailed } from '../src/messages.js';

const LANGUAGES = ['en', 'fr', 'de', 'es'];

/**
 * Check that a message carries every language of Gladys, none of them empty.
 * @param {string} name - What is being checked, for the failure message.
 * @param {object} message - The multi-language message.
 */
function assertTranslated(name, message) {
  assert.deepEqual(Object.keys(message).sort(), [...LANGUAGES].sort(), `${name}: languages`);
  for (const language of LANGUAGES) {
    assert.ok(message[language].trim().length > 0, `${name}.${language} is empty`);
  }
}

test('every user-facing message exists in the four languages of Gladys', () => {
  for (const [name, message] of Object.entries(MESSAGES)) {
    assertTranslated(name, message);
  }
  assertTranslated('testOk', testOk(2, 7));
  assertTranslated('testFailed', testFailed('timeout'));
  assertTranslated('reconnectOk', reconnectOk(3));
  assertTranslated('reconnectFailed', reconnectFailed('timeout'));
});

test('the values carried by a message reach every language untranslated', () => {
  for (const text of Object.values(testOk(2, 7))) {
    assert.match(text, /2/);
    assert.match(text, /7/);
  }
  for (const text of Object.values(testFailed('ECONNREFUSED'))) {
    assert.match(text, /ECONNREFUSED/);
  }
});

test('index.js carries no inline message left out of messages.js', () => {
  // An `fr:` key in index.js is a message that escaped the four-language table.
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfr:\s*['"`]/);
});
