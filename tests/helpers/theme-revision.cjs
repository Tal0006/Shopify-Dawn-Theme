// Stamps snippets/theme-revision.liquid with "<UTC date>+<short commit>": the day of the release and the commit the
// release was built on (the release commit itself contains this stamp, so it names its parent). Run before a release:
//   node tests/helpers/theme-revision.cjs --write
// Without --write it prints the current and the proposed label. The label is a diagnostic only (never a secret).
const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process');
const root = path.join(__dirname, '..', '..');
const FILE = path.join(root, 'snippets', 'theme-revision.liquid');
const PATTERN = /echo '([^']*)'/;
const FORMAT = /^\d{4}-\d{2}-\d{2}\+[0-9a-f]{7,12}$/;
const current = () => (fs.readFileSync(FILE, 'utf8').match(PATTERN) || [])[1] || null;
function proposed(now = new Date()) {
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root}).toString().trim();
  return now.toISOString().slice(0, 10) + '+' + commit;
}
if (require.main === module) {
  const next = proposed();
  if (process.argv.includes('--write')) {
    const text = fs.readFileSync(FILE, 'utf8');
    if (!PATTERN.test(text)) throw new Error('revision line not found in ' + FILE);
    fs.writeFileSync(FILE, text.replace(PATTERN, `echo '${next}'`));
    console.log('theme revision set to', next);
  } else console.log('current:', current(), ' proposed:', next);
}
module.exports = {current, proposed, FORMAT, FILE};
