const fs = require('node:fs');
const path = require('node:path');

function augmentScaffold(root) {
  const source = path.join(__dirname, 'fixtures', 'scaffold', 'src');
  fs.cpSync(source, path.join(root, 'src'), { recursive: true });
  const page = path.join(root, 'src', 'app', 'page.tsx');
  const original = fs.readFileSync(page, 'utf8');
  if (!original.includes('<UI.StatusBanner />')) {
    fs.writeFileSync(page,
      'import * as UI from "@/components";\n' +
      original.replace('<main ', '<UI.StatusBanner />\n      <main '));
  }
}

module.exports = { augmentScaffold };

if (require.main === module) augmentScaffold(path.resolve(process.argv[2]));
