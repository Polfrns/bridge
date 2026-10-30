# Historial del Bridge

La versión declarada sigue siendo 0.7.3. Los cambios del árbol de trabajo posteriores a esa entrega se describen como pendientes; esta revisión documental no publica una versión.

## Sin publicar — estado actual del repositorio

- Seguridad: la shell de Codex ya no recibe red al activar la búsqueda web. La búsqueda en vivo sigue funcionando porque la ejecuta el proveedor; antes un comando del sandbox podía alcanzar Roko y la LAN.
- Dependencias: zod 4.6.7 y parches transitivos de body-parser, fast-uri, ip-address y qs (npm audit sin vulnerabilidades). Se deniega el postinstall de protobufjs, que solo comprobaba versiones. El build ya no muestra avisos de debconf, npm notice/--force ni SecretsUsedInArgOrEnv; CODEX_AUTH_DIR/CLAUDE_AUTH_DIR salen del Dockerfile porque coincidían con CODEX_HOME/CLAUDE_CONFIG_DIR, que ya son su valor por defecto.
- Claude recibe Glob, Grep y NotebookEdit, confinados al workspace como Read/Write/Edit.
- El relay de funciones admite hasta 8 llamadas independientes por turno (`additional_calls`), respetando `parallel_tool_calls=false` y tool_choice.
- Toolkit: pandas, numpy, matplotlib, pdfplumber, reportlab y WeasyPrint; la imagen añade pandoc, Graphviz y OCR en catalán, francés, portugués, alemán e italiano. Nueva operación `recalc` para detectar errores de fórmula; `validate` comprueba la sintaxis de JSONL, CSV/TSV, TOML y Python. check:workspace prueba pandas/matplotlib y la disponibilidad de pandoc y dot en el sandbox.

- Búsqueda web nativa para Claude: con web_search activo recibe WebSearch y WebFetch, y las capacidades publicadas lo anuncian. Un hook limita WebFetch a destinos http(s) públicos para que el contenedor no sirva de acceso a Roko ni a la LAN. Roko deja de depender de Codex para buscar.

- Texto ordinario en directo desde eventos compatibles de Claude y Codex hacia Chat Completions y Responses, sin revisión semántica adicional ni repetición final.
- Entregas de archivos y decisiones de función retenidas hasta validar; reparación de archivos conservada y error explícito si falla una respuesta textual ya publicada.
- Actividad pública durante generación y reparación, con resúmenes por operación, detalles técnicos acotados en el chat y política de exportación independiente.
- Duraciones con procedencia execution/provider/observed; sin tiempos inventados para eventos terminales aislados.
- Capacidades por proveedor en models y banderas reasoningReplay/publicProgress/liveText/cliOptions en health.
- Presets Codex normal/deep con esfuerzo medium/high; Claude Fast usa Haiku. El ejemplo configura Sonnet/Haiku/Opus y Luna/Luna/Sol mediante variables de modelo.
- Validación estricta de opciones/objetos JSON y búsqueda derivada de la opción efectiva, sin conservar instrucciones obsoletas.
- Timeout predeterminado de diez minutos, código request_timeout y HTTP 504 antes de iniciar la respuesta.
- Validación de archivos con estado checked/partial/unavailable y explicaciones de entregas parciales o herramientas ausentes.
- Correcciones de regresiones: esperas de validación por registros V1 decodificados y localización del único terminal de un span aunque haya actualizaciones previas de contenido.
- Documentación consolidada: observabilidad en OBSERVABILITY.md, CI y despliegue en DEPLOY.md y resultados en TESTS.md. Se retiran las notas transitorias de ZIP/hotfix y los informes duplicados.

Última suite completa registrada: 215 pruebas Node y 11 Python aprobadas en la etapa Docker ci. Alcance y límites en [TESTS.md](TESTS.md).

## 0.7.3 — Responses reasoning replay

Se aceptan los elementos reasoning devueltos por Roko al continuar tras una herramienta. Se omiten del transcript CLI, sin descifrar encrypted_content ni convertirlos en instrucciones. Se conservan historial, function_call y function_call_output con sus IDs.

Corrige el error 422 al continuar un ciclo de herramientas. No ejecuta de nuevo la función ni cambia permisos, dependencias o pipeline. Las antiguas instrucciones de aplicar un ZIP de hotfix quedan sustituidas por las guías actuales.

## 0.7.2 — 2026-10-16

Contenido textual acotado según redacted/debug, saneamiento de secretos y binarios y conservación del nombre de la traza remota firmada. Pruebas HTTP y exportación con SDK Langfuse real y colectores OTLP locales.

## 0.7.1 — 2026-10-15

Clasificación de operaciones reales, estados V1, intentos, sesiones HMAC, contexto de trazado firmado y exportación privada. Instrumentación de preparación, recogida y validación sin fabricar operaciones a partir de la intención del usuario.

## 0.7.0

Integración inicial de Langfuse/OpenTelemetry y actividad visible en LibreChat, preservando relay de funciones, devolución de archivos y aislamiento.

Este historial cubre Bridge. Las versiones y pruebas de Roko/Filestore pertenecen a sus propios repositorios.

MODIFIED-FILES.json conserva el manifiesto histórico del paquete hotfix 0.7.3, incluidas las notas de entrega que ahora se han integrado en estas guías. No es un inventario del árbol actual ni una lista para preparar el próximo commit.
