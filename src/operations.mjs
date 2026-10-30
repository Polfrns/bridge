/** Classification uses SDK facts only. Commands are inspected locally and never exported. */
export const OPERATION_LABELS = Object.freeze({
  'workspace.list':'Listar archivos', 'workspace.read':'Leer archivo', 'workspace.write':'Crear archivo',
  'workspace.edit':'Editar archivo', 'workspace.delete':'Eliminar archivo', 'workspace.search':'Buscar en archivos',
  'workspace.mkdir':'Crear carpeta', 'workspace.validate':'Validar archivo',
  'file.upload':'Preparar adjunto', 'file.download':'Recoger archivos',
  'file.generated.python':'Archivo Python generado', 'file.generated.docx':'Documento Word generado',
  'file.generated.pdf':'PDF generado', 'file.generated.xlsx':'Hoja de cálculo generada',
  'file.generated.image':'Imagen generada', 'file.generated.other':'Archivo generado',
  'code.execute.python':'Ejecutar Python', 'code.execute.javascript':'Ejecutar JavaScript',
  'command_execution':'Comando del workspace', 'command.execute':'Ejecutar comando',
  'code.test':'Ejecutar pruebas', 'code.validate':'Validar código',
  'web.search':'Búsqueda web', 'web.fetch':'Consultar web', 'web.open':'Abrir web',
  'web.download':'Descargar de web', file_change:'Modificación de archivos',
  mcp_tool_call:'Herramienta MCP interna', todo_list:'Plan de trabajo',
  collab_tool_call:'Operación de agente', image_generation:'Generación de imagen',
});
export function commandOperation(command) {
  if (typeof command !== 'string') return 'command_execution';
  // Only a direct interpreter invocation. Shell wrappers and compound commands stay generic.
  if (/[;&|`\n\r]/.test(command)) return 'command_execution';
  const executable = command.trim().match(/^(?:"([^"\n]+)"|'([^'\n]+)'|([^\s]+))/);
  const name = (executable?.[1] ?? executable?.[2] ?? executable?.[3] ?? '').replace(/\\/g,'/').split('/').pop();
  if (/^python(?:[23](?:\.\d+)?)?(?:\.exe)?$/.test(name)) return 'code.execute.python';
  if (/^(node|nodejs)(?:\.exe)?$/.test(name)) return 'code.execute.javascript';
  return 'command_execution';
}
export function classifyOperation(value) {
  const item = value.item ?? value.input ?? {};
  const type = value.type;
  if (value.provider === 'bridge' && Object.hasOwn(OPERATION_LABELS, type)) return type;
  if (value.provider === 'codex') {
    if (['command_execution','exec_command'].includes(type)) return commandOperation(item.command ?? value.command);
    if (type === 'web_search') return 'web.search';
    if (type === 'file_change') {
      const kinds = new Set((item.changes ?? []).map(change => change.kind));
      if (kinds.size === 1) return ({add:'workspace.write',update:'workspace.edit',delete:'workspace.delete'})[[...kinds][0]] ?? type;
    }
    if (type === 'mcp_tool_call' && /^[A-Za-z0-9_.-]{1,100}$/.test(item.tool ?? '')) return `mcp.${item.tool}`;
    return Object.hasOwn(OPERATION_LABELS,type) ? type : null;
  }
  if (value.provider === 'claude') {
    const mapped = {Read:'workspace.read',Write:'workspace.write',Edit:'workspace.edit',MultiEdit:'workspace.edit',NotebookEdit:'workspace.edit',
      Glob:'workspace.list',Grep:'workspace.search',WebSearch:'web.search',WebFetch:'web.fetch'}[type];
    if (mapped) return mapped;
    if (['Bash','mcp__workspace__execute'].includes(type)) return commandOperation(item.command);
    if (/^mcp__[A-Za-z0-9_]+__[A-Za-z0-9_.-]+$/.test(type)) return type;
  }
  return null;
}
export function generatedOperation(filename) {
  const ext = String(filename).split('.').pop().toLowerCase();
  return 'file.generated.' + ({py:'python',docx:'docx',pdf:'pdf',xlsx:'xlsx',png:'image',jpg:'image',jpeg:'image',webp:'image',gif:'image',svg:'image'}[ext] ?? 'other');
}
