

## Actividad pública en directo (2026-10-19)

`test/live-progress.test.mjs` recorre los adaptadores reales `runClaude` y
`runCodex`, con SDK simulados y HTTP real firmado. Cruza ambos proveedores con
Chat Completions y Responses, en streaming y sin streaming. Una barrera mantiene
el turno pendiente hasta que el cliente haya recibido el comentario; un watchdog
falla si ese comentario queda retenido. Una variante retiene deliberadamente
ambos callbacks y comprueba que el watchdog la rechaza antes de liberar el turno.

También comprueba orden de comentarios/tarjetas, una sola emisión de cada delta,
IDs y estados V1, intentos separados, secuencias y ciclos Responses, errores sin
éxito final, timeout, desconexión y cierre del stream Claude. Una segunda barrera
detiene la validación de artefactos reparados: hay actividad en directo y todavía
no hay texto final ni bytes descargables. Las pruebas de privacidad rechazan
thinking, JSON final, contenido de herramientas, rutas, comandos, secretos,
Base64 y marcadores reservados; comprueban límites, deduplicación y desactivación.
Los fixtures de `parameters.test.mjs`, `providers.test.mjs` y `server.test.mjs`
usan el canal público y texto operativo permitido. El relay MCP, HMAC, aislamiento,
toolkit real, trazas y reparación conservan sus regresiones existentes.

Comprobaciones realizadas:

- `npm ci --ignore-scripts`: instalación de las versiones fijadas, auditoría sin
  vulnerabilidades. Consultas `npm view` verificaron los últimos SDK publicados,
  sin cambiar `package.json` ni el lockfile (ver SPEC).
- Pruebas dirigidas en Windows (actividad, artefactos, adaptadores, parámetros,
  servidor y progreso): 85 aprobadas, 2 omitidas por plataforma/toolkit, 0 fallos.
  Incluyen 27 casos de progreso y los controles de resumen con su rechazo en Claude.
- Suite Linux en un contenedor temporal `ai-librechat-bridge-bridge:latest`, sin
  red ni credenciales, montando `src/`, `test/`, `scripts/`, `package.json` y `.env.example` en solo
  lectura; `LANGFUSE_TRACING_ENABLED=false` y
  `FILE_TEST_PYTHON=/app/runtime-tools/bin/python`:
  `node --test --test-concurrency=1 --test-timeout=120000 test/*.test.mjs`, 172/172,
  y `python -m unittest discover -s test -p file_tools_test.py -v`, 9/9.
  La imagen contiene los mismos SDK fijados, Claude `0.3.291` y Codex `0.161.0`;
  reutiliza su toolkit Linux. No equivale a reconstruir la imagen de producción.
- `npm test` en Windows se ejecutó; las pruebas POSIX de workspace fallan al
  asumir shell Linux o buscar el paquete nativo Linux ausente en Windows. El
  entorno Python local carece de `pillow_heif` y `py7zr`, y no dispone de
  LibreOffice/FFmpeg; esos casos pasan con el toolkit del contenedor Linux.
- `npm run check:workspace` en Windows falla cerrado: el backend Windows
  configurado exige sandbox elevado para restringir lecturas. No se cambia la
  política ni se activa un fallback sin sandbox.
- `npm run check:sandbox` en Windows: aprobado con backend `unelevated`, escritura
  real en workspace y edición DOCX verificada. Es una prueba nativa determinista,
  sin inferencia ni llamada al modelo.
- `git diff --check`: sin errores de whitespace.

La suite usa eventos y barreras simulados, no sesiones autenticadas de modelos.
Quedan para el host de despliegue una sesión real por proveedor que verifique los
comentarios efectivamente emitidos, cancelación del CLI y entrega/reparación de
archivos y el check de workspace restringido en el host final. No se han desplegado cambios.

## Observabilidad v0.7.1

Observabilidad v0.7.1 protege clasificación, ciclo de vida, agrupación de sesiones, contexto de servicio autenticado y privacidad antes de OTLP. Véanse TEST-RESULTS.md para comandos/resultados y VERIFY-LANGFUSE.md para verificación de despliegue.


## Observabilidad v0.7.2

Entrada y salida textual acotada en observaciones existentes, según modo redacted/debug. El contexto remoto firmado conserva nombre de la traza raíz. Filtro de secretos/binarios también en debug; nuevas pruebas HTTP con SDK/OTLP reales. Versión de servicio 0.7.2, dependencias sin cambios.

Las pruebas nuevas comprueban límites de contenido, filtrado antes de exportar y no mutación de datos. Roko ejecuta processStream real sobre un grafo de prueba y comprueba trazas, títulos, usuarios, errores y cancelación. Bridge verifica por HTTP la firma y el padre remoto con SDK real. Filestore mantiene sus 12 herramientas y pruebas de acceso. Véanse TEST-RESULTS.md y OBSERVABILITY-V072.md.


## Hotfix Responses v0.7.3

Los elementos de input con type=reasoning se aceptan como metadatos de transporte y se omiten al construir el transcript CLI. Las cinco regresiones nuevas cubren Codex/Claude, estado opaco, continuación con previous_response_id, y roundtrip HTTP real tras function_call_output con/sin streaming. Las herramientas no se ejecutan en el normalizador. El estado opaco no se descifra ni se convierte en instrucciones.


## Langfuse metering regression (2026-10-16)

Content privacy tests assert SDK JSON usage/cost survives both content modes,
reject secret fields, nesting, malformed JSON and invalid numbers, and verify
export copies never mutate live attributes. Known Roko Bridge aliases suppress
duplicate accounting while direct models retain measurements.

`test/metering-export.test.mjs` uses the real Langfuse SDK with a local OTLP
collector to assert numeric metrics reach export and replica inference is disabled.
