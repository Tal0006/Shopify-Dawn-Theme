const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const parse = file => JSON.parse(read(file).replace(/^\s*\/\*[\s\S]*?\*\//, ''));
function flatten(object, prefix = '') { return Object.entries(object).flatMap(([key, value]) => typeof value === 'string' ? [[prefix + key, value]] : flatten(value, prefix + key + '.')); }
function files(dir) { return fs.readdirSync(path.join(root, dir), {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? files(dir + '/' + entry.name) : [dir + '/' + entry.name]); }
const he = new Map(flatten(parse('locales/he.default.json')));
const en = new Map(flatten(parse('locales/en.json')));
test('Hebrew is the only default and English retains identical translation coverage', () => {
  assert.deepEqual(fs.readdirSync(path.join(root, 'locales')).filter(file => file.endsWith('.default.json')), ['he.default.json']);
  assert.deepEqual([...he.keys()].sort(), [...en.keys()].sort());
  for (const [key, value] of he) assert.ok(!value.includes('???'), 'Invalid UTF-8 translation: ' + key);
});
test('Translations preserve all interpolation variables', () => {
  const variables = text => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(match => match[1]).sort();
  for (const [key, value] of en) assert.deepEqual(variables(he.get(key)), variables(value), key);
});
test('Every literal storefront translation reference resolves, including plural keys', () => {
  for (const file of ['sections', 'snippets', 'layout', 'templates'].flatMap(files).filter(file => file.endsWith('.liquid'))) {
    for (const match of read(file).matchAll(/['"]([^'"\n]+)['"]\s*\|\s*t\b/g)) assert.ok(he.has(match[1]) || he.has(match[1] + '.other'), file + ': ' + match[1]);
  }
});
test('Template dependencies, block types, ordering and numeric settings remain valid', () => {
  const schemas = new Map(files('sections').filter(file => file.endsWith('.liquid')).map(file => { const match = read(file).match(/{% schema %}([\s\S]*?){% endschema %}/); return [path.basename(file, '.liquid'), match ? JSON.parse(match[1]) : {}]; }));
  for (const file of files('templates').filter(file => file.endsWith('.json'))) {
    const template = parse(file);
    for (const id of template.order) assert.ok(template.sections[id], file + ': missing ordered section ' + id);
    for (const section of Object.values(template.sections)) {
      assert.ok(schemas.has(section.type), file + ': missing section ' + section.type);
      const schema = schemas.get(section.type);
      for (const block of Object.values(section.blocks || {})) assert.ok((schema.blocks || []).some(definition => definition.type === block.type), file + ': unknown block ' + block.type);
    }
  }
  const definitions = parse('config/settings_schema.json').flatMap(group => group.settings || []);
  const data = parse('config/settings_data.json');
  for (const values of [data.current, ...Object.values(data.presets || {})]) for (const setting of definitions.filter(setting => setting.type === 'range')) {
    const value = values[setting.id]; if (value === undefined) continue;
    assert.equal(typeof value, 'number', setting.id);
    assert.ok(value >= setting.min && value <= setting.max, setting.id);
    assert.ok(Math.abs((value-setting.min)/setting.step-Math.round((value-setting.min)/setting.step)) < 1e-8, setting.id);
  }
});
