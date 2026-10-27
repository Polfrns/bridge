# Contrato actual del bridge

Referencia del código actual: versión declarada 0.7.3 más los cambios locales descritos en [CHANGELOG.md](CHANGELOG.md). Los SDK instalados están fijados en [package.json](package.json) y [package-lock.json](package-lock.json): Claude Agent SDK 0.3.291 y Codex SDK 0.161.0. Son versiones del proyecto, no una afirmación sobre las últimas publicaciones del registro.

## Identidad y runtime

`GET /health` es público. Las demás rutas requieren `Authorization: Bearer <BRIDGE_API_KEY>`, con clave de al menos 32 caracteres y comparación en tiempo constante.

Cada inferencia requiere `x-roko-context` y `x-roko-signature`. El primero contiene JSON en Base64URL con tenantId, userId, conversationId, model, options y timestamp; el segundo es HMAC-SHA256 hexadecimal del valor exacto del primero, con la clave compartida. Se comprueban tipos, longitudes, correspondencia de modelo y antigüedad máxima de diez minutos antes de iniciar el proveedor. No existe identidad anónima de respaldo.

El propietario de estado deriva de tenant, usuario, conversación y proveedor mediante HMAC. Los alias de un proveedor comparten ese ámbito, sin compartir una sesión persistente del modelo.

Cada petición crea workspace, HOME, cachés y temporales nuevos. Se copia únicamente el material OAuth necesario; no se importan instrucciones, skills, MCP ni historiales del host. El acceso al fichero OAuth se serializa por proveedor; una renovación segura puede conservarse sin sobrescribir cambios concurrentes. Se limpia el runtime al finalizar o cancelar normalmente.

La continuidad depende del historial y archivos reenviados por Roko. Responses conserva estado en memoria por propietario durante 30 minutos, con máximo de 1000 entradas. Reiniciar el proceso invalida esos identificadores.

## HTTP

| Ruta | Contrato |
| --- | --- |
| `GET /health` | Vida y versión; capacidades `reasoningReplay`, `publicProgress`, `liveText`, `cliOptions`. No comprueba login ni sandbox. |
| `GET /v1/models` | Alias con controles y esfuerzo predeterminado por proveedor. |
| `POST /v1/chat/completions` | Mensajes, adjuntos, funciones y SSE. |
| `POST /v1/responses` | Mensajes, archivos/imágenes, funciones, SSE y `previous_response_id`. |

Las inferencias reciben un objeto JSON. Valores predeterminados: cuerpo máximo 20 MiB, dos peticiones activas y timeout de 600000 ms. `MAX_CONCURRENT_REQUESTS` y `REQUEST_TIMEOUT_MS` ajustan los dos últimos. Desconexión o timeout abortan proveedor y procesos asociados.

| HTTP | Motivo habitual |
| --- | --- |
| 400 | JSON, modelo, opciones o estado de continuación inválidos. |
| 401 | Bearer o identidad firmada inválidos. |
| 413 | Tamaño máximo excedido. |
| 415 | Content-Type distinto de JSON. |
| 422 | Tipo de contenido, herramienta o parámetro no soportado. |
| 429 | Concurrencia agotada. |
| 502 | Fallo del proveedor o resultado inválido. |
| 503 | Login OAuth ausente/inválido. |
| 504 | Timeout antes de enviar cabeceras; código `request_timeout`. |

Los errores usan un objeto `error`. Una vez iniciado SSE, el error se comunica dentro del stream; no puede cambiarse el estado HTTP ya enviado. Cancelación y timeout tienen códigos distintos.

## Modelos y opciones

| Alias | Selección sin variables de perfil | Esfuerzo |
| --- | --- | --- |
| `claude-max` | `CLAUDE_MODEL` o default del CLI | medium |
| `claude-max-fast` | haiku | low |
| `claude-max-deep` | opus | high |
| `gpt-codex` | `CODEX_MODEL` o default del CLI | medium |
| `gpt-codex-fast` | `CODEX_MODEL` o default del CLI | low |
| `gpt-codex-deep` | `CODEX_MODEL` o default del CLI | high |

Precedencia: modelo general del entorno, preset, variable FAST/DEEP, opciones firmadas, campos explícitos del cuerpo. Dentro del cuerpo, las formas anidadas reasoning/text sustituyen sus equivalentes planos y `cli_options` tiene la última precedencia. Los valores Auto/unset mantienen el preset.

`cli_options` y las opciones firmadas admiten únicamente model, reasoning_effort, verbosity, reasoning_summary y web_search. El modelo backend debe pertenecer a los configurados en el entorno, los presets del proveedor o su lista `*_ALLOWED_MODELS`. Permisos, rutas y sandbox se deciden en el servidor.

| Control | Codex | Claude |
| --- | --- | --- |
| reasoning_effort | minimal, low, medium, high, xhigh, max, ultra, persistent | low, medium, high, xhigh, max |
| verbosity | low, medium, high | No |
| reasoning_summary | auto, concise, detailed, none | No |
| web_search nativo | Booleano | Booleano: true añade WebSearch y WebFetch |

La aceptación por el adaptador no garantiza disponibilidad para cada modelo/cuenta. El bridge propaga opciones nativas: Codex recibe model/modelReasoningEffort y configuración de resumen/verbosidad; Claude recibe model/effort y persistSession=false.

Se toleran valores neutros heredados como temperature=1, top_p=1, penalizaciones=0 y n=1. Otros valores o controles no implementados —incluidos límites de tokens y stop— se rechazan explícitamente. No se simula su efecto. Las instrucciones de búsqueda se derivan del interruptor efectivo de la petición y no permanecen activadas en el historial al deshabilitarlo.

## Relay y herramientas internas

Las funciones se declaran con esquema de tipo function. El modelo devuelve una decisión message/tool_call; el bridge valida nombre, argumentos y elección de herramienta antes de emitir la llamada OpenAI. Roko ejecuta la función y devuelve su resultado. No se ejecutan funciones externas durante la normalización.

Responses acepta `function_call` y `function_call_output` conservando call_id. Los elementos de entrada `reasoning`, incluido encrypted_content, son metadatos de transporte: se aceptan y omiten del transcript CLI. No se descifran ni se convierten en instrucciones o herramientas. Los demás tipos no soportados siguen rechazándose.

Codex utiliza su sandbox workspace-write, approvalPolicy=never y búsqueda/red según la opción efectiva. Claude recibe Read/Write/Edit limitados al workspace y el MCP interno `mcp__workspace__execute`, con descripción pública opcional. Con web_search activo recibe además WebSearch y WebFetch. WebFetch se ejecuta dentro del contenedor del bridge, que alcanza las redes de Roko y la LAN, por lo que un hook rechaza destinos no http(s), con credenciales, nombres de una sola etiqueta o locales (.local, .lan, .internal, .home.arpa) y cualquier dirección resuelta privada, loopback, link-local, CGNAT, multicast o NAT64. La comprobación DNS no cubre un rebinding posterior. No requiere otro servidor ni puerto.

La shell de Claude utiliza el sandbox nativo de Codex, con red desactivada, permisos limitados y comprobación previa de aislamiento. Linux usa shell POSIX y Windows PowerShell. No hay fallback sin sandbox. Comandos: máximo 16000 caracteres, timeout de 1 a 120 segundos y captura máxima de 1 MiB, con respuesta textual adicionalmente acotada. El entorno heredado se filtra y se cancelan procesos hijos.

## Streaming de texto y actividad

Para respuestas ordinarias el proveedor declara primero:

```json
{"artifact":{"task":"answer","status":"text","files":[]},"response":{"text":"Respuesta"}}
```

Con relay, response.action=message debe preceder a response.text. El decodificador extrae únicamente ese texto; no realiza una revisión semántica ni ejecuta otro modelo revisor. Claude usa eventos parciales raíz de texto o StructuredOutput; Codex usa instantáneas acumuladas agent_message y emite solo el sufijo nuevo.

Chat envía `delta.content`; Responses envía `response.output_text.delta`, con índices y secuencias coherentes con la actividad recibida. No se repite el texto al finalizar. Thinking, mensajes de subagentes, argumentos de otras herramientas y JSON interno no son fuentes de texto de respuesta.

Si el SDK no comunica fragmentos compatibles, o el orden del sobre no permite identificarlos, se conserva el fallback atómico. No se garantiza granularidad por token. Sin streaming se devuelve una respuesta completa.

Después de publicar texto, un fallo, cancelación, sustitución de instantánea o sobre inválido termina con error, sin éxito final ni reparación que reescriba la respuesta visible. Responses marca el mensaje incompleto y emite response.failed; no se guarda una continuación exitosa.

Archivos, unsupported y decisiones de función esperan su validación. El bloque `LIBRECHAT_OUTPUT_V1` debe comenzar el contenido de una entrega de archivos; no se le antepone prosa. Las tarjetas y comentarios públicos siguen circulando durante inferencia y reparación. Su contrato y privacidad están en [OBSERVABILITY.md](OBSERVABILITY.md).

## Adjuntos y entregables

Los bloques de imagen/archivo aceptan URLs de datos Base64. Una URL remota no autoriza al servidor a descargarla. Se conserva el original con nombre saneado, MIME y bytes; lectores administrados generan vistas/texto acotados sin ejecutar código subido automáticamente.

Entrada: 10 archivos, 15 MiB por archivo y 20 MiB de cuerpo total, incluido Base64. Salida: 10 archivos, 15 MiB por archivo y 15 MiB combinados. El inventario del workspace también está limitado.

El sobre de artefactos declara task=edit/create/answer/code, status=files/text/unsupported y una lista de rutas. Los finales van en outputs/ y los auxiliares en work/. Un entregable debe existir, ser regular, no vacío, no ser un enlace y haber cambiado frente al snapshot inicial. Un script auxiliar no sustituye a un documento editado. El código fuente solicitado expresamente sí puede ser un entregable task=code.

La recogida aplica límites, comprobaciones de rutas y firmas básicas; el toolkit valida formatos cuando está disponible. La actividad informa validationStatus=checked/partial/unavailable. No debe interpretarse un validador ausente como comprobación estructural realizada. Incluso checked no demuestra calidad semántica ni fidelidad visual.

Ante un resultado inválido hay un intento de reparación en el mismo runtime, salvo que ya se haya publicado prosa. No puede sustituirse una entrega rechazada por texto ordinario; debe repararse o declararse unsupported. Las instrucciones permiten explicar partes no disponibles junto con entregables válidos, sin afirmar un éxito completo.

Office depende de bibliotecas Python y LibreOffice; OCR de Tesseract; medios de FFprobe/FFmpeg. Transcripción requiere el extra multimedia y pesos Faster-Whisper locales, sin descarga durante peticiones. Los archivos comprimidos se inspeccionan contra escapes, enlaces, dispositivos, cifrado y excesos; no se extraen recursivamente archivos internos. Véanse [src/file-formats.mjs](src/file-formats.mjs) y [scripts/file-tools.py](scripts/file-tools.py).

## Configuración y verificación

[.env.example](.env.example) documenta modelos, autenticación, límites, herramientas y telemetría. Cambiarlo no modifica el entorno activo. Código en Docker requiere rebuild; cambios de .env requieren recreación. En producción CI se conserva la imagen fijada: [DEPLOY.md](DEPLOY.md).

health solo mide disponibilidad HTTP. check:workspace comprueba el ejecutor restringido de Claude, sin login ni inferencia; añade edición DOCX si el toolkit está instalado. check:sandbox comprueba el sandbox nativo de Codex sin llamar a un modelo, aunque su preparación usa el runtime con credenciales Codex. Los checks deben ejecutarse con el usuario y host reales.

Las pruebas reproducibles y sus límites están en [TESTS.md](TESTS.md). Las restricciones funcionales están en [LIMITATIONS.md](LIMITATIONS.md).