const SUMMARY_LIMIT = 240;

function shortText(value, maximum = 100) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maximum ? text.slice(0, maximum - 1) + '…' : text;
}

function filename(value) {
  if (typeof value !== 'string') return undefined;
  return shortText(value.replace(/\\/g, '/').split('/').pop(), 70);
}

function names(values) {
  const unique = [...new Set(values.filter(Boolean))];
  return unique.slice(0, 2).join(' y ') + (unique.length > 2 ? ` y ${unique.length - 2} más` : '');
}

/** Public declared intent is preferred; fallbacks describe observed inputs only. */
export function activitySummary(value, event) {
  const input = value.item ?? value.input ?? {};
  const declared = shortText(input.description ?? value.description, SUMMARY_LIMIT);
  if (declared && !/[[\]{}]|(?:[A-Za-z]:\\|\/(?:app|data|home|tmp|workspace)\/)/.test(declared)) return declared;
  const target = filename(value.filename ?? input.file_path ?? input.path);
  const changes = Array.isArray(input.changes) ? input.changes : [];
  if (changes.length) {
    const groups = [
      { kind: 'add', verb: 'Crea' }, { kind: 'update', verb: 'Actualiza' }, { kind: 'delete', verb: 'Elimina' },
    ].map(group => {
      const files = changes.filter(change => change.kind === group.kind).map(change => filename(change.path));
      return files.length ? `${group.verb} ${names(files)}` : '';
    }).filter(Boolean);
    if (groups.length) return shortText(groups.join('; ') + '.', SUMMARY_LIMIT);
  }
  const count = event.fileCount;
  const operations = {
    'workspace.list': value.provider === 'bridge'
      ? count === 0 && event.state !== 'started' ? 'El workspace no tenía archivos de entrada.'
        : `Comprueba ${count === undefined ? 'los archivos de entrada' : `${count} archivos de entrada`} antes de comenzar.`
      : `Localiza archivos${shortText(input.pattern ?? input.glob) ? ` que coincidan con «${shortText(input.pattern ?? input.glob)}»` : ' disponibles para la tarea'}.`,
    'workspace.read': `Lee ${target ?? 'el archivo seleccionado'} para obtener la información necesaria.`,
    'workspace.write': `Crea ${target ?? 'el archivo de trabajo'} con el contenido preparado.`,
    'workspace.edit': `Aplica cambios en ${target ?? 'el archivo seleccionado'}.`,
    'workspace.delete': `Elimina ${target ?? 'el archivo seleccionado'} del workspace.`,
    'workspace.search': `Busca ${shortText(input.pattern) ? `«${shortText(input.pattern)}»` : 'coincidencias'}${target ? ` en ${target}` : ' en los archivos de trabajo'}.`,
    'file.upload': `Prepara ${count === undefined ? 'los adjuntos' : `${count} adjuntos`} para que el modelo pueda utilizarlos.`,
    'file.download': `Recoge ${count === undefined ? 'los entregables' : `${count} archivos`} para adjuntarlos a la respuesta.`,
    'workspace.validate': `Comprueba el formato de ${count === undefined ? 'los entregables' : `${count} archivos`} antes de entregarlos.`,
    'web.search': `Busca ${shortText(input.query) ? `información sobre «${shortText(input.query)}»` : 'fuentes web para resolver la consulta'}.`,
    'web.fetch': 'Consulta la página seleccionada para obtener información para la tarea.',
  };
  if (event.operation.startsWith('file.generated.')) return `Prepara ${target ?? 'el archivo generado'} para descargarlo.`;
  if (Object.hasOwn(operations, event.operation)) return shortText(operations[event.operation], SUMMARY_LIMIT);
  const command = input.command ?? value.command;
  if (typeof command === 'string') {
    const scripts = [...command.matchAll(/(?:^|[\s"'])([^\s"';&|]+\.(?:py|[cm]?js|ts|ps1|sh))(?=[\s"';&|]|$)/g)]
      .map(match => filename(match[1]));
    const scriptNames = names(scripts);
    if (scriptNames) return shortText(`Utiliza ${scriptNames} en este paso de la tarea.`, SUMMARY_LIMIT);
    const commands = [...command.matchAll(/(?:command\s+-v|Get-Command|which)\s+([\w.+-]+)/gi)].map(match => match[1]);
    if (commands.length) return shortText(`Comprueba si están disponibles ${names(commands)}.`, SUMMARY_LIMIT);
    return 'Ejecuta una operación del entorno; su finalidad no viene descrita en el evento.';
  }
  return `${event.label}: realiza la operación solicitada por el modelo.`;
}
