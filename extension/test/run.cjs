const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function register(root, entry = require.resolve('../out/extension.js'), configs = []) {
  const commands = new Map();
  const webview = { onDidReceiveMessage() {}, asWebviewUri: value => value };
  const vscode = {
    ViewColumn: { One: 1 },
    Uri: { joinPath: path.join },
    commands: { registerCommand: (name, handler) => commands.set(name, handler) },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }],
      onDidSaveTextDocument() {},
      openTextDocument() {},
      findFiles: async () => configs.map(fsPath => ({ fsPath })),
      asRelativePath: file => path.relative(root, file),
    },
    window: {
      createWebviewPanel: () => ({ webview, onDidDispose() {} }),
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
    require(entry).activate({ subscriptions: [], extensionUri: root });
  } finally {
    Module._load = load;
  }
  return { commands, webview };
}

async function generate(root, entry, configs = []) {
  await register(root, entry, configs).commands.get('neo.generateGraph')();
  const project = fs.existsSync(path.join(root, 'tsconfig.json'))
    ? root : path.dirname(configs[0]);
  return fs.readFileSync(path.join(project, 'codebase_graph.md'), 'utf8');
}

async function visualize(root) {
  const { commands, webview } = register(root);
  await commands.get('neo.showGraph')();
  const [, payload] = /const rawData = "([^"]+)"/.exec(webview.html);
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

module.exports = { generate, visualize };

if (require.main === module) {
  const [root, entry] = process.argv.slice(2);
  generate(path.resolve(root), entry ? path.resolve(entry) : undefined).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
