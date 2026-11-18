const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

async function generate(root, entry = require.resolve('../out/extension.js'), configs = []) {
  const commands = new Map();
  const vscode = {
    commands: { registerCommand: (name, handler) => commands.set(name, handler) },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }],
      onDidSaveTextDocument() {},
      openTextDocument() {},
      findFiles: async () => configs.map(fsPath => ({ fsPath })),
      asRelativePath: file => path.relative(root, file),
    },
    window: {
      withProgress: (_options, run) => run({ report() {} }),
      showInformationMessage() {},
      showTextDocument() {},
      showErrorMessage: message => { throw new Error(message); },
    },
    ProgressLocation: { Notification: 1 },
  };
  const load = Module._load;
  Module._load = function (name, ...args) {
    return name === 'vscode' ? vscode : load.call(this, name, ...args);
  };
  try {
    delete require.cache[entry];
    require(entry).activate({ subscriptions: [] });
  } finally {
    Module._load = load;
  }
  await commands.get('neo.generateGraph')();
  const project = fs.existsSync(path.join(root, 'tsconfig.json'))
    ? root : path.dirname(configs[0]);
  return fs.readFileSync(path.join(project, 'codebase_graph.md'), 'utf8');
}

module.exports = { generate };

if (require.main === module) {
  const [root, entry] = process.argv.slice(2);
  generate(path.resolve(root), entry ? path.resolve(entry) : undefined).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
