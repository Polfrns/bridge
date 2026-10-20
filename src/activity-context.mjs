import descriptions from './activity-descriptions.json' with { type: 'json' };

/** @typedef {keyof typeof descriptions} ActivityDetailCode */
/** @typedef {{pattern: string, detailCode: ActivityDetailCode}} PythonLibraryRule */

// Only identify the executable and known library imports. Never publish the
// command, inline script, arguments, stdout or model-supplied descriptions.
/** @param {unknown} command @returns {ActivityDetailCode | undefined} */
function commandContext(command, depth = 0) {
  if (typeof command !== 'string' || command.length > 65536 || depth > 2) return undefined;
  const text = command.trim()
    .replace(/^(?:cd|Set-Location)\s+(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s;&|]+)\s*(?:;|&&)\s*/i, '')
    .replace(/^&\s+/, '');
  const executable = text.match(/^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;|&]+))\s*/);
  if (!executable) return undefined;
  const name = (executable[1] ?? executable[2] ?? executable[3]).replace(/\\/g, '/').split('/').pop().toLowerCase();
  const args = text.slice(executable[0].length);
  if (/^(?:powershell|pwsh|bash|sh|zsh|cmd)(?:\.exe)?$/.test(name)) {
    const nested = args.match(/(?:^|\s)(?:-command|-c|-lc|\/c)\s+([\s\S]+)$/i)?.[1]?.trim();
    if (nested) {
      const unquoted = (nested[0] === '"' || nested[0] === "'") && nested.at(-1) === nested[0]
        ? nested.slice(1, -1) : nested;
      const inner = commandContext(unquoted, depth + 1);
      if (inner) return inner;
    }
    return /^(?:powershell|pwsh)/.test(name) ? 'shell.powershell' : /^cmd/.test(name) ? 'shell.cmd' : 'shell.posix';
  }
  if (/^python(?:[23](?:\.\d+)?)?(?:\.exe)?$/.test(name)) {
    /** @type {PythonLibraryRule[]} */
    const libraries = [
      {pattern: 'fitz|pymupdf', detailCode: 'python.pdf'},
      {pattern: 'docx', detailCode: 'python.docx'},
      {pattern: 'openpyxl', detailCode: 'python.spreadsheet'},
      {pattern: 'pptx', detailCode: 'python.presentation'},
      {pattern: 'PIL', detailCode: 'python.image'},
    ];
    const usesLibrary = (names) => new RegExp(`(?:\\bfrom\\s+(?:${names})[.\\s]|\\bimport\\s+(?:${names})\\b)`).test(args);
    const matched = libraries.filter(rule => usesLibrary(rule.pattern));
    // A mixed-format script gets a general description instead of arbitrarily
    // claiming that its first import is the purpose of the whole operation.
    if (matched.length === 1) return matched[0].detailCode;
    return 'python.script';
  }
  if (/^(?:node|nodejs)(?:\.exe)?$/.test(name)) return 'javascript.script';
  /** @type {Readonly<Record<string, ActivityDetailCode>>} */
  const commands = {
    'get-childitem': 'shell.list', ls: 'shell.list', dir: 'shell.list',
    'get-content': 'shell.read', cat: 'shell.read', head: 'shell.read', tail: 'shell.read',
    rg: 'shell.search', 'rg.exe': 'shell.search', grep: 'shell.search', 'select-string': 'shell.search',
    'get-command': 'shell.environment', which: 'shell.environment', 'where.exe': 'shell.environment',
  };
  return Object.hasOwn(commands, name) ? commands[name] : undefined;
}

export function activityContext(value, operation) {
  if (value.provider === 'bridge') {
    if (operation === 'workspace.list') return 'workspace.inventory';
    if (operation.startsWith('file.generated.')) return 'file.deliver';
    return Object.hasOwn(descriptions, operation) ? operation : undefined;
  }
  if (value.type === 'mcp_tool_call' || value.type?.startsWith('mcp__') && value.type !== 'mcp__workspace__execute') return undefined;
  if (['command_execution', 'exec_command', 'Bash', 'mcp__workspace__execute'].includes(value.type)) {
    const input = value.item ?? value.input ?? {};
    const command = input.command ?? value.command;
    return commandContext(command) ?? (typeof command === 'string' && command.trim() ? 'command_execution' : undefined);
  }
  return Object.hasOwn(descriptions, operation) ? operation : undefined;
}

export function activityDescription(code) {
  return typeof code === 'string' && Object.hasOwn(descriptions, code) ? descriptions[code] : undefined;
}
