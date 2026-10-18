# Bridge v0.7.3 — corrección de Responses tras MCP

Base: bridge-observability-v0.7.2.zip entregado en este chat. No cambia Roko ni
Filestore, sus permisos, redes, firmas de contexto ni variables de entorno.

## Fallo corregido

Bridge emitía output de type=reasoning (resúmenes y actividad). Al devolver Roko
ese output junto con function_call_output, el parser rechazaba la segunda petición
con HTTP 422: Responses input item type "reasoning" is not supported.

Ahora el parser acepta y omite esos metadatos al construir el transcript del CLI.
Conserva los mensajes, function_call y function_call_output. No convierte reasoning
en instrucciones ni en llamadas ejecutables. El estado encrypted_content se ignora:
el adaptador CLI no lo descifra ni ofrece persistencia de estado interno Responses.
Los otros tipos no soportados siguen teniendo el comportamiento anterior.

Esto corrige la continuación después de una herramienta; no vuelve a ejecutarla
desde el parser. Las herramientas MCP siguen ejecutándose en el cliente actual.
Las pruebas HTTP usan un proveedor de prueba, no tu servidor MCP desplegado.

## Aplicación

El ZIP hotfix contiene solamente archivos nuevos/modificados, dentro de bridge/.
Copia SU CONTENIDO sobre el repositorio local de Bridge, conservando .env y todos
los otros archivos. El ZIP completo es una alternativa; no necesitas aplicar ambos.
Consulta MODIFIED-FILES.json. No copies node_modules ni secretos a Git.

Desde el repositorio local de Bridge, revisa y sube los archivos:

```bash
git add src/protocol.mjs test/protocol.test.mjs test/server.test.mjs package.json package-lock.json CHANGELOG.md SPEC.md TESTS.md TEST-RESULTS.md HOTFIX-RESPONSES-V073.md MODIFIED-FILES.json
git diff --cached --stat
git diff --cached --check
git commit -m "fix: accept Responses reasoning replay after MCP tools"
git push origin main
```

El pipeline existente ejecuta los tests/build en Bitbucket Cloud y solo después
despliega la imagen probada por digest. No cambies el pipeline ni reconstruyas
manualmente en la VM. Los scripts ci/ pueden existir solo en el checkout del runner:
no se presupone que estén bajo ~/services/bridge en la VM.

Tras el despliegue, verifica desde rokoface:

```bash
curl -fsS http://127.0.0.1:4000/health
```

Debe anunciar version 0.7.3. Inicia una consulta nueva en Roko: "mira qué hay en el
filestore". Comprueba que list_filestores devuelve su resultado y el modelo termina
la respuesta. La traza existente continúa usando roko.interaction como raíz.
La prueba real contra tu MCP y proveedores queda pendiente de esa comprobación.

## Rollback

Desde tu equipo revierte el commit del hotfix con git revert y haz push a main.
El pipeline probará/desplegará la reversión. No borres volúmenes, datos ni .env.
Revertir a 0.7.2 restaura también el error 422 cuando se reproduce ese formato.
