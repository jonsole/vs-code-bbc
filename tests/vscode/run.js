// Runs suite.js inside a real VS Code with this extension loaded: activation,
// the debugger end to end through VS Code's own DAP client, the screen panel.
//   npm run test:vscode            (needs a display: xvfb-run -a npm run test:vscode on Linux)
// The first run downloads VS Code into .vscode-test/.
'use strict';

const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  try {
    await runTests({
      version: process.env.VSCODE_VERSION || 'stable',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [path.join(root, 'examples', 'hello'), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome'],
      extensionTestsEnv: {
        BBC_TEST_HTTP_PORT: '18821',
        BBC_TEST_DAP_PORT: '14821',
        BBC_TEST_SCREENSHOT: process.env.BBC_TEST_SCREENSHOT || '',
      },
    });
  } catch (e) {
    console.error(e.message ?? e);
    process.exit(1);
  }
}

main();
