# Roko CLI Bridge

Bridge privado para conectar Roko/LibreChat con Claude Code y Codex mediante Chat Completions y Responses. Roko conserva las conversaciones y archivos; el bridge ejecuta cada petición en un workspace nuevo, transmite texto y actividad, y devuelve los entregables comprobados.

La versión declarada en [package.json](package.json) es **0.7.3**. Esta documentación describe el código actual del repositorio, incluidos los cambios locales posteriores a esa versión; no acredita qué imagen está desplegada.

## Empezar

- Instalación local con contenedores y conexión a Roko: [DOCKER.md](DOCKER.md).
- Instalación nativa en Ubuntu o Windows: [UBUNTU.md](UBUNTU.md).
- Producción con Bitbucket, registro y rollback: [DEPLOY.md](DEPLOY.md).

La configuración de referencia está en [.env.example](.env.example). Conserva tu `.env` existente al actualizar. El bridge y Roko deben compartir `BRIDGE_API_KEY` / `CLAUDE_BRIDGE_KEY`; cada inferencia requiere además identidad firmada por el backend de Roko.

## Modelos y controles

Los nombres publicados son alias del bridge. La selección efectiva depende del entorno, el preset y los controles permitidos de la petición.

| Alias | Backend con el ejemplo actual de entorno | Esfuerzo del preset |
| --- | --- | --- |
| `claude-max` | `claude-sonnet-5-5` | medium |
| `claude-max-fast` | `claude-haiku-5-5` | low |
| `claude-max-deep` | `claude-opus-5-5` | high |
| `gpt-codex` | `gpt-6-luna` | medium |
| `gpt-codex-fast` | `gpt-6-luna` | low |
| `gpt-codex-deep` | `gpt-6.1-sol` | high |

Estos valores proceden del archivo de ejemplo, que no cambia automáticamente un `.env` instalado. Sin variables de modelo, Codex utiliza el default del CLI; Claude normal utiliza su default y los presets Fast/Deep seleccionan `haiku`/`opus`. Los IDs configurados requieren disponibilidad en la cuenta del proveedor.

La configuración actual de Codex Deep usa esfuerzo **high**, según [src/presets.mjs](src/presets.mjs). Los controles explícitos admitidos pueden sustituirlo. Consulta la precedencia y las allowlists en [SPEC.md](SPEC.md).

## Texto, actividad y herramientas

El texto ordinario se envía según llegan fragmentos compatibles del SDK, sin una revisión semántica adicional. La granularidad depende del proveedor: si solo comunica un mensaje completo, se publica ese bloque. Las entregas con archivos siguen esperando la recogida, validación y posible reparación.

Las tarjetas muestran operaciones reales y comentarios públicos mientras se ejecuta el proveedor. Pueden incluir comandos, argumentos seleccionados y salida textual en la conversación autenticada. La política de exportación a Langfuse es independiente; no se muestra pensamiento privado. Véase [OBSERVABILITY.md](OBSERVABILITY.md).

Roko ejecuta las funciones externas que el modelo pide mediante el relay, incluidas las herramientas MCP configuradas allí. El bridge no ejecuta esas funciones. Claude dispone además de una herramienta interna `mcp__workspace__execute` y lectura/edición restringidas al workspace; Codex utiliza sus herramientas nativas. La búsqueda web nativa está disponible para Codex cuando se activa.

## Archivos

El bridge conserva los bytes originales y prepara texto o vistas con las herramientas instaladas. No ejecuta automáticamente scripts adjuntos.

| Grupo | Tratamiento |
| --- | --- |
| Office y OpenDocument | Lectura/edición con bibliotecas Python; conversión y vistas con LibreOffice. La conversión puede cambiar diseño, macros o fórmulas. |
| PDF e imágenes | Texto, vistas, edición y validación según formato; OCR con Tesseract. |
| Texto, datos y código | Lectura acotada y validación cuando existe un lector compatible. |
| ZIP, 7z, TAR y compresiones | Extracción limitada, sin rutas de escape, enlaces ni extracción recursiva de archivos internos. |
| Audio y vídeo | Metadatos y fotogramas con FFprobe/FFmpeg; transcripción opcional con modelo Faster-Whisper local. |
| Otros binarios | Transporte del original; no implica disponer de lector, editor o compilador. |

Entrada: hasta 10 archivos, 15 MiB por archivo y 20 MiB de cuerpo HTTP, incluido Base64. Salida: hasta 10 archivos, 15 MiB por archivo y 15 MiB combinados. Roko puede imponer límites menores.

Los entregables deben existir bajo `outputs/`, ser regulares, no vacíos y haber cambiado. Los auxiliares pertenecen a `work/`. La comprobación estructural depende del validador instalado y no acredita la calidad del contenido. El catálogo ejecutable está en [src/file-formats.mjs](src/file-formats.mjs) y [scripts/file-tools.py](scripts/file-tools.py).

## API y ejecución

| Ruta | Acceso |
| --- | --- |
| `GET /health` | Público; vida, versión y capacidades declaradas. |
| `GET /v1/models` | Bearer; alias y controles por proveedor. |
| `POST /v1/chat/completions` | Bearer e identidad HMAC; JSON o SSE. |
| `POST /v1/responses` | Bearer e identidad HMAC; JSON o SSE, continuación temporal. |

El timeout predeterminado es 600000 ms y la concurrencia máxima es 2. Cada petición recibe runtime, HOME y temporales nuevos; se copia solo la autenticación OAuth necesaria y se limpia al terminar. El historial y los adjuntos reenviados por Roko proporcionan la continuidad.

El sandbox requiere comprobación en el host final. No hay fallback de shell sin aislamiento. La imagen Docker incluye Node 24, Python, LibreOffice, FFmpeg, Tesseract y bubblewrap; instala las dependencias fijadas en el lockfile.

## Documentación

| Guía | Contenido |
| --- | --- |
| [SPEC.md](SPEC.md) | Contrato HTTP, opciones, streaming, identidad y archivos. |
| [DOCKER.md](DOCKER.md) | Instalación Compose local, redes y volúmenes. |
| [UBUNTU.md](UBUNTU.md) | Instalación nativa en Ubuntu y Windows. |
| [DEPLOY.md](DEPLOY.md) | Pipeline Cloud, configuración del runner y gestión por imagen fijada. |
| [OPERATIONS.md](OPERATIONS.md) | Diagnóstico, cambios de entorno y actualización. |
| [OBSERVABILITY.md](OBSERVABILITY.md) | Actividad, privacidad, Langfuse y comprobación integral. |
| [LIMITATIONS.md](LIMITATIONS.md) | Límites de capacidad, aislamiento y medición. |
| [TESTS.md](TESTS.md) | Comandos, cobertura y resultados verificados. |
| [CHANGELOG.md](CHANGELOG.md) | Historial de versiones y cambios pendientes de publicación. |