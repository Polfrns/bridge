# Especificación funcional del bridge

Este documento define el contrato actual entre Roko/LibreChat y el servicio bridge: identidad, protocolos, ejecución de proveedores, archivos, herramientas, aislamiento y límites. No es una promesa de que las APIs subyacentes de OpenAI, Anthropic o los CLI acepten todos sus parámetros. El código y las pruebas del repositorio son la referencia ejecutable.

## 1. Propósito y alcance

El bridge adapta las solicitudes de modelos personalizados de LibreChat a los SDK de Claude Code y Codex. Proporciona:

- API HTTP compatible con las formas usadas por OpenAI Chat Completions y Responses.
- Autenticación del cliente de Roko y verificación HMAC de usuario, tenant y conversación.
- Sesiones de proveedor y directorios de trabajo temporales aislados por petición.
- Transporte y preparación de adjuntos; selección, validación y retorno de entregables.
- Relay de llamadas a funciones para que Roko ejecute herramientas configuradas por LibreChat.
- Búsqueda web de Codex y una herramienta de shell limitada para Claude.
- Ejecución opcional con dependencias locales de documentos, imágenes, archivos comprimidos, audio y vídeo.

El bridge no guarda conversaciones ni archivos permanentes, no despliega servicios MCP adicionales, no ejecuta modelos alojados de OpenAI para File Search/Code Interpreter y no implementa almacenamiento de LibreChat. Roko sigue siendo dueño del historial y de los archivos persistentes.

## 2. Componentes

| Componente | Responsabilidad |
| --- | --- |
| Roko/LibreChat | UI, sesiones, historial, opciones, configuración de agentes/herramientas, almacenamiento de archivos y descarga de entregables. Firma el contexto de cada petición. |
| Servidor bridge | Autentica, valida identidad y parámetros, prepara runtime, enruta proveedor, adapta protocolos, aplica límites y limpia la petición. |
| Claude Agent SDK | Bucle de agente Claude, lectura/edición dentro del workspace, herramienta MCP interna de ejecución y salida estructurada. |
| Codex SDK y CLI | Bucle de agente Codex, shell, herramientas del CLI y sandbox del sistema operativo. El CLI Codex también aporta el ejecutor nativo del sandbox que usa la herramienta de shell de Claude. |
| Toolkit Python | Lectura, vistas, extracción segura, conversión y validación de formatos con los módulos y ejecutables instalados. |

El SDK proporciona el runtime del proveedor. La API compatible con LibreChat, firma de contexto, reglas de aislamiento, preparación de adjuntos, contrato de entregables y despliegue son responsabilidad de este bridge.

## 3. Identidad, autenticación y aislamiento

### 3.1 HTTP

Las rutas de inferencia y descubrimiento de modelos requieren:

```http
Authorization: Bearer <BRIDGE_API_KEY>
```

La clave debe tener al menos 32 caracteres. La comparación del bearer token se hace en tiempo constante. `GET /health` es una ruta de vida sin autenticación y no expone credenciales ni identidad.

### 3.2 Contexto firmado de Roko

Cada inferencia requiere estos headers:

| Header | Contenido |
| --- | --- |
| `x-roko-context` | JSON serializado y codificado en Base64URL con `tenantId`, `userId`, `conversationId`, `model`, `options` y `timestamp`. |
| `x-roko-signature` | HMAC-SHA256 hexadecimal del valor exacto de `x-roko-context`, usando `BRIDGE_API_KEY`. |

El bridge comprueba firma, edad máxima de diez minutos, modelo igual al del cuerpo, tipos y longitudes de identificadores antes de resolver el proveedor o consultar estado de Responses. No existe modo anónimo ni fallback a una identidad compartida.

El propietario de estado se deriva con HMAC del tenant, usuario, conversación y proveedor. Los alias rápido/profundo del mismo proveedor comparten el ámbito propietario, pero **no una sesión del modelo persistida entre solicitudes**. Un cambio de tenant, usuario, conversación o proveedor crea otro ámbito.

### 3.3 Runtime de cada petición

Cada llamada crea un directorio aleatorio dentro de la rama de runtime derivada de la identidad. Dentro se crean workspace, HOME, caché, configuración y temporales nuevos. Se copia el archivo OAuth necesario del proveedor a ese HOME efímero; no se copian sus instrucciones globales, sesiones anteriores, configuración MCP ni skills del host.

El acceso al archivo OAuth compartido se serializa por proveedor. Si el CLI refresca credenciales, solo la renovación se conserva y solo si otro proceso no ha cambiado entretanto el archivo original. El workspace y el HOME temporal se eliminan al terminar, incluso al producirse error o cancelación normales.

La continuidad del chat la proporciona el historial enviado por Roko y los archivos que Roko vuelve a adjuntar. No depende de que el workspace siga existiendo. Un reinicio, limpieza o petición nueva no recupera un directorio de trabajo anterior.

El estado de `previous_response_id` de Responses vive en memoria del proceso durante 30 minutos, se limita a 1000 entradas y se vincula al propietario. Se pierde al reiniciar el bridge; el cliente debe enviar de nuevo el historial cuando el identificador ya no exista o haya expirado.

## 4. API HTTP

Todas las rutas salvo `/health` requieren Bearer. Las inferencias también requieren contexto firmado.

| Método y ruta | Autenticación | Comportamiento |
| --- | --- | --- |
| `GET /health` | No | Devuelve estado de vida y banderas de capacidades. No verifica OAuth, permisos efectivos de Docker ni sandbox del kernel. |
| `GET /v1/models` | Bearer | Devuelve los modelos virtuales disponibles. |
| `POST /v1/chat/completions` | Bearer + HMAC | Acepta mensajes, adjuntos base64, funciones y streaming SSE. |
| `POST /v1/responses` | Bearer + HMAC | Acepta texto, mensajes, imágenes/archivos base64, funciones, streaming SSE y continuación acotada con `previous_response_id`. |

El cuerpo debe ser JSON. Tamaño máximo predeterminado: 20 MiB. Máximo predeterminado de peticiones activas en el proceso: 2; ajustable con `MAX_CONCURRENT_REQUESTS`. Tiempo máximo predeterminado: 180000 ms; ajustable con `REQUEST_TIMEOUT_MS`. El cliente desconectado o el timeout abortan la llamada al proveedor y su ejecución.

### 4.1 Códigos de error más relevantes

| HTTP | Uso |
| --- | --- |
| 400 | JSON, modelo, contexto o parámetros inválidos; estado de Responses desconocido/expirado. |
| 401 | Bearer ausente/incorrecto o firma/contexto Roko inválido. |
| 413 | Cuerpo, adjunto o entregables por encima de sus límites. |
| 415 | Petición de inferencia no JSON. |
| 422 | Tipo de contenido/herramienta o parámetro que el runtime CLI no admite. |
| 429 | Máximo de concurrencia alcanzado. |
| 502 | Fallo del proveedor u output inválido. |
| 503 | OAuth de fichero ausente o inválido. |

Los errores usan un objeto `error` JSON. En streaming, un fallo después de iniciar la respuesta se transmite como evento final de error y finalización.

## 5. Modelos y parámetros

Identificadores virtuales:

| Identificador | Proveedor | Predeterminado |
| --- | --- | --- |
| `claude-max` | Claude | Modelo configurado por host o default del CLI; esfuerzo medio. |
| `claude-max-fast` | Claude | Sonnet o `CLAUDE_FAST_MODEL`; esfuerzo bajo. |
| `claude-max-deep` | Claude | Opus o `CLAUDE_DEEP_MODEL`; esfuerzo alto. |
| `gpt-codex` | Codex | Modelo configurado por host o default del CLI; esfuerzo medio. |
| `gpt-codex-fast` | Codex | Modelo configurado por host/perfil rápido; esfuerzo bajo. |
| `gpt-codex-deep` | Codex | Modelo configurado por host/perfil profundo; esfuerzo alto. |

El anfitrión puede fijar modelos backend mediante variables de entorno y listas allowlist. El orden de selección es: default del host, preset virtual, opción efectiva firmada por Roko y opción explícita permitida en la petición. El esquema de permisos nunca proviene del usuario.

Controles procesados: `model`, `reasoning_effort`, `verbosity`, `reasoning_summary` y `web_search`, según capacidades del proveedor. Codex admite esfuerzos hasta las opciones que define el CLI, verbosidad low/medium/high, resúmenes auto/concise/detailed/none y búsqueda web nativa. Claude admite el esfuerzo compatible con su SDK/CLI; no expone aquí verbosidad, resumen de razonamiento ni búsqueda nativa. Claude puede recibir búsqueda de Roko mediante el relay de función.

El bridge rechaza con error explícito valores de generación incompatibles o no implementados, incluidos cambios en temperature, top-p, penalizaciones, límites de tokens y parámetros de muestreo. Los valores neutros que LibreChat pueda enviar por defecto se toleran. El bridge no inventa un control equivalente si el CLI no lo ofrece.

## 6. Herramientas y llamadas de función

### 6.1 Relay de LibreChat

El bridge admite esquemas de herramientas de tipo `function`. Incluye en las instrucciones del agente las definiciones permitidas y la elección auto/required/none. Si el agente elige una función, el bridge devuelve una llamada con el nombre y argumentos JSON en el protocolo OpenAI; Roko ejecuta la función según su propia configuración y devuelve el resultado en el siguiente turno.

El relay no ejecuta por sí mismo las funciones MCP de Roko. Tipos de herramientas alojadas que no sean funciones se rechazan, salvo búsqueda nativa de Codex cuando la petición la configura. File Search y Code Interpreter alojados de OpenAI no son herramientas implementadas por este bridge.

### 6.2 Shell y archivos

Codex ejecuta comandos y Python desde su sandbox en el workspace temporal. Claude recibe Read/Write/Edit restringidos a ese workspace y una herramienta MCP creada en memoria, `mcp__workspace__execute`, para shell y herramientas binarias.

En Linux, la shell de Claude corre dentro del sandbox nativo de Codex, con filesystem raíz restringido, acceso de escritura únicamente al workspace, red desactivada y recursos de lectura explícitos. Codex usa su sandbox de workspace; su red está desactivada por defecto y puede habilitarse en la petición que activa búsqueda web nativa. El bridge valida la prueba del sandbox de Claude antes de ejecutar el primer comando. En Windows nativo, usa PowerShell y el sandbox Windows configurado por el administrador. Si no se prueba el sandbox de Claude, la petición se bloquea; no existe fallback sin aislamiento.

Los comandos tienen máximo 16000 caracteres y timeout individual de 1 a 120 segundos. Salida capturada máxima de 1 MiB; la respuesta de herramienta se acota aún más. Se eliminan variables de credenciales, proxies y entorno que no estén permitidas. Se cancelan los procesos hijos al abortar, exceder tiempo o límite.

## 7. Adjuntos y archivos

### 7.1 Entrada

Se aceptan como adjuntos imágenes y archivos en bloques de contenido con URL de datos `data:<mime>;base64,...`. URL remota de imagen/archivo no equivale a una descarga del servidor y se rechaza. Se mantienen nombre, MIME y bytes, con saneamiento del nombre antes de crear el archivo local.

Máximo: diez archivos, 15 MiB de bytes por archivo, 20 MiB para el cuerpo HTTP total. El Base64 aumenta el tamaño en el transporte. Roko y el cliente web pueden aplicar límites menores.

El bridge guarda el original. El toolkit lee formatos conocidos y genera texto/vistas acotadas. Para Office, PDF, imágenes y archivos comprimidos usa bibliotecas instaladas; para documentos antiguos puede generar una copia convertida. Audio/vídeo se inspecciona con FFprobe y se pueden extraer fotogramas con FFmpeg. OCR necesita Tesseract. Transcripción requiere el extra multimedia y pesos de Whisper instalados por el administrador: no se descargan durante una petición.

Los archivos comprimidos se inspeccionan antes de extraer: se rechazan enlaces/rutas de escape, dispositivos, cifrado y excesos de entradas/tamaño. Los comprimidos internos se conservan sin extracción recursiva. Código adjunto no se ejecuta salvo instrucción explícita del usuario.

El mapa MIME de `src/file-formats.mjs`, los lectores de `scripts/file-tools.py` y sus pruebas definen el catálogo actual. Tener extensión reconocida significa que se puede transportar y clasificar; no asegura lector, edición o conversión completa.

### 7.2 Salida

El agente devuelve un sobre estructurado con texto de respuesta y metadatos de tarea/archivos. Para crear o editar, los archivos finales deben estar en `outputs/`; los scripts auxiliares se guardan en `work/`. Cada salida declarada debe existir, ser regular, no estar vacía, haber cambiado respecto al snapshot inicial y pasar el validador disponible. Una extensión de código no puede sustituir a un documento que se solicitó editar.

Máximo: diez archivos por respuesta, 15 MiB por archivo y 15 MiB combinados. El bridge devuelve bytes Base64, nombre y MIME a Roko. La validación estructural no juzga si el texto revisado es correcto ni conserva de forma garantizada todas las funciones/layouts propietarios de los formatos.

Si un output declarado es inválido o falta, el bridge hace un intento de reparación en el mismo runtime. Solo entonces se devuelve respuesta de éxito; si no se puede validar, la solicitud termina con error/limitación sin publicar una afirmación de éxito.

## 8. Despliegue y configuración

### Docker Compose

El Dockerfile instala un runtime Linux, Node, los SDK y binarios opcionales, Python/toolkit, LibreOffice, FFmpeg, Tesseract y bubblewrap. Compose ejecuta como usuario no root, con raíz de imagen de solo lectura, volúmenes de login y datos, límite de procesos y puerto del host ligado a loopback.

Para integrar Roko en otro proyecto Compose del mismo host, se conecta su API a la red externa `roko-cli-bridge` y se usa el alias interno `http://cli-bridge:4000/v1`. El puerto local publicado es solo para comprobación desde el host; no debe usarse como URL de contenedor.

Para bubblewrap anidado, el servicio declara `SYS_ADMIN` y ajustes de seccomp/AppArmor específicos del contenedor. Esto amplía el perfil de ese servicio frente a Docker predeterminado. No se usa modo privileged, socket de Docker ni bind mount del host. VM, Docker rootless, kernel o políticas de seguridad pueden impedir el sandbox anidado; el check debe ejecutarse en el host real y una falla bloquea shell.

### Instalación nativa

Node.js 22 o superior. Python 3.10+ para el toolkit. Ubuntu requiere herramientas de sandbox/conversión del sistema; Windows usa PowerShell y el sandbox nativo de Codex. `npm ci` instala dependencias fijadas; `npm run setup` crea clave local si falta; `npm run setup:files` instala el entorno Python. Las dependencias y ejecutables deben ser nativos de ese sistema operativo.

### Variables principales

`BRIDGE_API_KEY`, `BRIDGE_HOST`, `BRIDGE_PORT`, `BRIDGE_DATA_DIR`, `REQUEST_TIMEOUT_MS`, `MAX_CONCURRENT_REQUESTS`, `CLAUDE_MODEL`, `CODEX_MODEL`, perfiles FAST/DEEP, directorios OAuth, allowlists, rutas a LibreOffice/FFmpeg/Tesseract, idioma OCR y ruta al modelo Whisper. La referencia completa está en [.env.example](.env.example).

## 9. Comprobaciones

| Comando | Verifica | Requiere login del modelo |
| --- | --- | --- |
| `npm test` | Tests automáticos de protocolo, proveedores, archivos, herramientas, parámetros, aislamiento, wrappers y sandbox simulado. | No |
| `npm run check:workspace` | Sandbox de workspace de Claude, escritura real en workspace y edición/validación DOCX si toolkit disponible. | No |
| `npm run check:sandbox` | Sandbox de Codex y la prueba de ejecución de ese flujo. | Sí, Codex |
| `docker compose exec bridge bridge health` | Liveness HTTP solamente. | No |
| `docker compose exec bridge bridge check:workspace` | Prueba de workspace desde el contenedor. | No |
| `docker compose exec bridge bridge check:sandbox` | Prueba de sandbox Codex en el contenedor. | Sí, Codex |

Un test que simula un launcher no es una prueba de un kernel real. La instalación final debe pasar los checks nativos en su Docker/Ubuntu/Windows, además de una petición al proveedor que se vaya a usar.

## 10. Registros y depuración

Los errores incluyen categoría y código. Se registran los fallos de herramientas y del proveedor de forma acotada. `BRIDGE_DEBUG_ATTACHMENTS=1` registra el modelo, nombre, MIME y bytes de cada adjunto, nunca sus bytes. `BRIDGE_DEBUG_PROVIDER=1` permite incluir comando/salida acotados en logs locales de Codex; deja el ajuste desactivado salvo diagnóstico controlado. No envíes logs con credenciales o documentos a terceros.

## 11. No objetivos y límites funcionales

- El bridge no es una API genérica para todos los proveedores OpenAI-compatible; valida los dos runtimes CLI y modelos virtuales declarados.
- No garantiza que todos los tipos MIME del navegador sean interpretables o editables por el agente.
- No mantiene el filesystem entre peticiones y no es una alternativa a MongoDB/almacenamiento de archivos de Roko.
- No ofrece una garantía de virtualización/aislamiento de kernel equivalente a una VM dedicada. El sandbox comparte kernel y usuario de servicio.
- No transforma toda opción de generación de LibreChat en opción válida de CLI. Controles incompatibles fallan claramente.
- No promete equivalencia de modelos, razonamiento, búsqueda o calidad de salida entre Claude y Codex.

## 12. Criterio para cambios

Un cambio de protocolo debe preservar las dos formas de respuesta, la identidad firmada, el control de adjuntos, la frontera de herramientas y los límites de tamaño. Un cambio del workspace debe fallar cerrado, cancelar y limpiar procesos/archivos en el flujo normal y tener una prueba de regresión significativa. Un cambio de formatos debe documentar conversión, validación y dependencias opcionales; no debe presentar solo la etiqueta MIME como prueba de capacidad.



## Observabilidad v0.7.1

Observabilidad v0.7.1: exportación privada, contexto HMAC por servicio y operaciones basadas en eventos reales. Véanse CHANGELOG.md y LIMITATIONS.md. Los permisos y datos enviados al modelo no cambian.


## Observabilidad v0.7.2

Entrada y salida textual acotada en observaciones existentes, según modo redacted/debug. El contexto remoto firmado conserva nombre de la traza raíz. Filtro de secretos/binarios también en debug; nuevas pruebas HTTP con SDK/OTLP reales. Versión de servicio 0.7.2, dependencias sin cambios.

Las pruebas nuevas comprueban límites de contenido, filtrado antes de exportar y no mutación de datos. Roko ejecuta processStream real sobre un grafo de prueba y comprueba trazas, títulos, usuarios, errores y cancelación. Bridge verifica por HTTP la firma y el padre remoto con SDK real. Filestore mantiene sus 12 herramientas y pruebas de acceso. Véanse TEST-RESULTS.md y OBSERVABILITY-V072.md.


## Hotfix Responses v0.7.3

Los elementos de input con type=reasoning se aceptan como metadatos de transporte y se omiten al construir el transcript CLI. Las cinco regresiones nuevas cubren Codex/Claude, estado opaco, continuación con previous_response_id, y roundtrip HTTP real tras function_call_output con/sin streaming. Las herramientas no se ejecutan en el normalizador. El estado opaco no se descifra ni se convierte en instrucciones.
