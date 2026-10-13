// The four languages of the Gladys interface (en, fr, de, es) everywhere a
// user reads the integration: the manifest, the runtime messages, the docs and
// the READMEs. The integration declares no widget, so there is no widget text
// nor generated widget illustration to check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as messages from '../src/messages.js';

const LANGUAGES = ['en', 'fr', 'de', 'es'];
const READMES = { en: 'README.md', fr: 'README.fr.md', de: 'README.de.md', es: 'README.es.md' };
const REPO_RAW = 'https://raw.githubusercontent.com/William-De71/gladys-yeelight/main';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const exists = (path) => existsSync(new URL(`../${path}`, import.meta.url));
const manifest = JSON.parse(read('gladys-assistant-integration.json'));

/**
 * @description Every multi-language object of a value, with its path.
 * @param {unknown} value - The value.
 * @param {string} path - Its path.
 * @returns {Array<[string, object]>} The objects.
 */
function texts(value, path = '') {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => texts(item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    if (typeof value.en === 'string') {
      return [[path, value]];
    }
    return Object.entries(value).flatMap(([key, item]) => texts(item, `${path}.${key}`));
  }
  return [];
}

test('every text of the manifest exists in the four languages', () => {
  const found = texts(manifest);
  assert.ok(found.length > 20, `only ${found.length} texts found`);
  for (const [path, text] of found) {
    for (const language of LANGUAGES) {
      assert.equal(typeof text[language], 'string', `${path}.${language}`);
      assert.ok(text[language].trim().length > 0, `${path}.${language}`);
    }
  }
});

test('every runtime message exists in the four languages', () => {
  const built = [
    ...Object.values(messages.MESSAGES),
    messages.testOk(2, 14),
    messages.testFailed('timeout'),
    messages.reconnectOk(3),
    messages.reconnectFailed('timeout'),
  ];
  for (const message of built) {
    assert.deepEqual(Object.keys(message).sort(), [...LANGUAGES].sort());
  }
});

test('the catalog description and the scene trigger labels fit the store limits', () => {
  for (const language of LANGUAGES) {
    const { length } = manifest.description[language];
    assert.ok(length >= 10 && length <= 100, `description.${language}: ${length}`);
    for (const entry of [...manifest.scene_triggers, ...manifest.scene_actions]) {
      assert.ok(entry.label[language].length <= 100, `scene ${entry.key}.${language}`);
    }
  }
});

test('the four docs exist, are long enough and share the same structure', () => {
  const shape = (text) => ({
    headings: text.match(/^#+ /gm).map((h) => h.trim()),
    tableRows: (text.match(/^\|/gm) ?? []).length,
  });
  const reference = shape(read('docs/en.md'));
  for (const language of LANGUAGES) {
    assert.ok(exists(`docs/${language}.md`), `docs/${language}.md`);
    const text = read(`docs/${language}.md`);
    assert.ok(text.length > 300, `docs/${language}.md is too short`);
    assert.deepEqual(shape(text), reference, `docs/${language}.md structure`);
  }
});

test('the four READMEs exist, link to each other and share the same structure', () => {
  const shape = (text) => ({
    headings: text.match(/^#+ /gm).map((h) => h.trim()),
    tableRows: (text.match(/^\|/gm) ?? []).length,
  });
  const reference = shape(read(READMES.en));
  for (const file of Object.values(READMES)) {
    const text = read(file);
    assert.deepEqual(shape(text), reference, `${file} structure`);
    for (const other of Object.values(READMES)) {
      if (other !== file) {
        assert.ok(text.includes(`(${other})`), `${file} links to ${other}`);
      }
    }
  }
});

test('every README shows the cover, the docs do not (the store already does)', () => {
  for (const language of LANGUAGES) {
    assert.ok(read(READMES[language]).includes('](cover.jpg)'), `${READMES[language]}: cover`);
    assert.ok(!read(`docs/${language}.md`).includes('cover.jpg'), `docs/${language}.md: no cover`);
  }
});

test('the docs show their images from the repository, as the store re-hosts them', () => {
  for (const language of LANGUAGES) {
    for (const [, target] of read(`docs/${language}.md`).matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      assert.ok(target.startsWith(`${REPO_RAW}/`), `docs/${language}.md: ${target}`);
      assert.ok(exists(target.slice(REPO_RAW.length + 1)), `docs/${language}.md: ${target}`);
    }
  }
});

test('every relative link of the READMEs points to an existing file', () => {
  for (const file of Object.values(READMES)) {
    for (const [, target] of read(file).matchAll(/\]\(((?!https?:|#)[^)\s]+)\)/g)) {
      assert.ok(exists(target.split('#')[0]), `${file}: ${target}`);
    }
  }
});

test('every README carries the four badges, in order, under the language bar', () => {
  for (const file of Object.values(READMES)) {
    const badges = [
      ...read(file).matchAll(/^\[!\[[^\]]+\]\((https:\/\/img\.shields\.io\/[^)]+)\)\]/gm),
    ].map(([, url]) => url);
    assert.equal(badges.length, 4, file);
    assert.match(badges[0], /badge\/(license|licence|Lizenz|licencia)-Apache--2\.0/, file);
    assert.match(badges[1], /github\/v\/release\/William-De71\/gladys-yeelight\?sort=semver/, file);
    assert.match(badges[2], /actions\/workflow\/status\/.*release\.yml/, file);
    assert.match(
      badges[3],
      new RegExp(`Gladys-%E2%89%A5%20${manifest.gladys_version.slice(2)}-`),
      file,
    );
  }
});
