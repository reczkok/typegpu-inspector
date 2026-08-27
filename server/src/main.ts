#!/usr/bin/env node

// One executable: editors start the language server with a transport flag
// (`--stdio`, `--node-ipc`, ...); anything else is the CLI, which also owns
// the empty invocation so a bare run prints usage. Loading lazily keeps each
// path free of the other's code.
const argv = process.argv.slice(2);
const LSP_TRANSPORT_FLAG = /^--(stdio|node-ipc|socket=|pipe=)/;

if (argv.some((arg) => LSP_TRANSPORT_FLAG.test(arg))) {
  void import('./server.js');
} else {
  void import('./cli.js').then(async ({ runCli }) => {
    const code = await runCli(argv);
    // The runtime child or a watcher may still hold the event loop; leave
    // once stdout has drained so piped output is never cut short.
    process.stdout.write('', () => process.exit(code));
  });
}
