import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DISCOVERY_PORT } from '../src/yeelight/constants.js';

const manifest = JSON.parse(
  readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url)),
);

test('the manifest declares the fields Gladys requires', () => {
  for (const field of [
    'manifest_version',
    'type',
    'name',
    'version',
    'docker_image',
    'gladys_version',
  ]) {
    assert.ok(manifest[field], `${field} is required`);
  }
  assert.equal(manifest.type, 'device');
});

test('the manifest respects the length limits Gladys enforces', () => {
  // Gladys rejects the whole manifest — with a generic "invalid manifest"
  // message — when these bounds are exceeded, so they are worth pinning.
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30, 'name must be 3-30 chars');
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} must be 10-100 chars, got ${text.length}`,
    );
  }
  assert.ok(manifest.description.en, 'the en description is mandatory');
});

test('the manifest root fields match the documented contract', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'strict semver');
  assert.ok(manifest.cover_image.startsWith('https://'), 'cover_image must be https');
  assert.ok(manifest.transports.length > 0);
  assert.ok(manifest.transports.every((transport) => ['local', 'cloud'].includes(transport)));
  assert.ok(manifest.actions.length >= 1 && manifest.actions.length <= 10, '1 to 10 actions');
  assert.ok(manifest.network_discovery.length <= 5, 'at most 5 discovery methods');
  for (const action of manifest.actions) {
    if (action.timeout_seconds !== undefined) {
      assert.ok(
        action.timeout_seconds >= 5 && action.timeout_seconds <= 120,
        `${action.key}: timeout_seconds must be 5-120`,
      );
    }
  }
});

test('the declared discovery port is the one the code broadcasts on', () => {
  // Yeelight uses its OWN SSDP variant on 1982, not standard SSDP on 1900: a
  // `ssdp` capture would never see a bulb. An undeclared port is a 403.
  const discovery = manifest.network_discovery.find(
    (entry) => entry.type === 'udp-active-broadcast',
  );
  assert.ok(discovery, 'an active broadcast capture must be declared');
  assert.deepEqual(discovery.ports, [DISCOVERY_PORT]);
  assert.equal(DISCOVERY_PORT, 1982);
});

test('every config field carries the parts the Configuration screen renders', () => {
  for (const field of manifest.config_schema) {
    assert.ok(field.key, 'a config field needs a key');
    assert.ok(field.label && field.label.en, `${field.key}: an en label is mandatory`);
    if (field.type === 'section') {
      // A section stores no value: declaring these would reject the manifest.
      assert.equal(field.required, undefined, `${field.key}: a section has no "required"`);
      assert.equal(field.default, undefined, `${field.key}: a section has no "default"`);
      assert.equal(field.placeholder, undefined, `${field.key}: a section has no "placeholder"`);
    }
    for (const link of field.links || []) {
      assert.ok(link.url.startsWith('https://'), `${field.key}: links must be https`);
    }
    for (const [lang, text] of Object.entries(field.description || {})) {
      assert.ok(text.length <= 1000, `${field.key}.${lang}: description must be <= 1000 chars`);
    }
  }
});

test('the manifest version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(manifest.version, pkg.version);
  // The release workflow keeps the image tag in lockstep with the version.
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    'docker_image must be tagged with the manifest version',
  );
});

test('the config defaults agree with the ones the code falls back to', async () => {
  // A drift here means the user sees one value in the form and the integration
  // uses another.
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    const field = manifest.config_schema.find((entry) => entry.key === key);
    assert.ok(field, `${key} must be declared in the config_schema`);
    assert.equal(field.default, value, `${key}: default drift between manifest and code`);
  }
});

test('the LAN Control prerequisite is stated in the configuration screen', () => {
  // A bulb without it refuses every local command; a user who does not know
  // that has no way to diagnose an integration that finds nothing.
  const intro = manifest.config_schema.find((field) => field.key === 'intro');
  assert.match(intro.description.en, /LAN Control/);
  assert.match(intro.description.fr, /Contrôle LAN/);
  assert.match(intro.description.de, /LAN-Steuerung/);
  assert.match(intro.description.es, /Control LAN/);
});

test('the config bounds agree with the ones the code clamps to', async () => {
  const { CONFIG_BOUNDS } = await import('../src/config.js');
  for (const [key, { min, max }] of Object.entries(CONFIG_BOUNDS)) {
    const field = manifest.config_schema.find((entry) => entry.key === key);
    assert.equal(field.min, min, `${key}: min drift between manifest and code`);
    assert.equal(field.max, max, `${key}: max drift between manifest and code`);
  }
});

test('every text of the manifest exists in the four languages of Gladys', () => {
  // A field translated in English only shows up in English in a German
  // interface; this keeps a new field from shipping half-translated.
  const missing = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') {
      return;
    }
    if (typeof node.en === 'string') {
      for (const language of ['en', 'fr', 'de', 'es']) {
        if (typeof node[language] !== 'string' || node[language].trim() === '') {
          missing.push(`${path}.${language}`);
        }
      }
      return;
    }
    Object.entries(node).forEach(([key, value]) => walk(value, `${path}.${key}`));
  };
  walk(manifest, '$');
  assert.deepEqual(missing, []);
});

test('the user documentation exists in the four languages of Gladys', () => {
  for (const language of ['en', 'fr', 'de', 'es']) {
    const doc = readFileSync(new URL(`../docs/${language}.md`, import.meta.url), 'utf-8');
    assert.ok(doc.length > 1000, `docs/${language}.md looks empty`);
  }
});

test('the repository ships the license package.json declares', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.license, 'Apache-2.0');
  const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf-8');
  assert.match(license, /Apache License\s+Version 2\.0/);
});
