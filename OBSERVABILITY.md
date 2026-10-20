# Actividad y observabilidad

Esta guía reúne la configuración, el contrato y la verificación de observabilidad del Bridge actual. La interfaz de Roko y los servicios MCP externos pertenecen a otros repositorios; su estado desplegado debe comprobarse por separado.

## Actividad en la conversación

Los callbacks de operaciones y comentarios públicos atraviesan el turno del proveedor y la validación/reparación. Tanto Chat Completions como Responses pueden mostrarlos antes de terminar la respuesta. Los registros `[[ROKO_BRIDGE_TOOL_V1:base64url]]` son presentación: nunca se convierten en tool_calls ejecutables.

Solo se representan operaciones observadas. Los estados son started/completed/failed/cancelled, con IDs estables, intentos conocidos y un único terminal. La preparación, inventario, recogida, validación y entrega tienen propósitos distintos. detailCode usa el vocabulario de [src/activity-descriptions.json](src/activity-descriptions.json); fileCount y validationStatus aportan medidas cuando existen.

Los resúmenes priorizan una descripción pública de la operación. Codex puede asociar un comentario breve a la siguiente herramienta; Claude execute admite description. Las alternativas usan datos observados de archivos, patrones, consultas, scripts o comprobaciones de herramientas. Un comando exitoso no implica que el documento sea correcto.

La proyección del chat puede incluir comando real, argumentos seleccionados, descripción, basename y salida textual. El registro JSON tiene máximo 32 KiB; comando 4096 bytes, argumentos 6144, salida 8192 y descripción 1024, sujetos al presupuesto total. Se eliminan controles/ANSI. El cliente Roko necesita un parser compatible con los registros ampliados. Las tarjetas MCP externas conservan su presentación propia.

El chat autenticado y la exportación tienen políticas distintas. OBSERVABILITY_CONTENT_MODE y OBSERVABILITY_FILE_NAMES no ocultan esos detalles en la conversación. No se usa el pensamiento privado del modelo ni se incluyen bloques binarios de adjuntos como diagnóstico de herramientas.

## Duraciones y cobertura

Las duraciones explícitas del ejecutor/proveedor se conservan. Las operaciones del Bridge y execute de Claude usan reloj monótono. Si solo se conoce el intervalo entre eventos recibidos, timingSource=observed lo identifica como tiempo observado. Un evento terminal sin inicio no recibe una duración inventada.

El Bridge limita las operaciones distintas por petición a 1000. Los reintentos de reparación llevan attempt 1/2; reintentos internos que el SDK no comunica no se fabrican. Tampoco se descompone una shell en lecturas/escrituras individuales invisibles al SDK.

BRIDGE_ACTIVITY_ENABLED=false desactiva la actividad pública, sin desactivar herramientas ni trazas. LANGFUSE_TRACING_ENABLED=false desactiva la exportación, sin desactivar la actividad.

## Configurar Langfuse

Configura el entorno privado del servicio:

```dotenv
LANGFUSE_BASE_URL=https://tu-instancia-langfuse
LANGFUSE_PUBLIC_KEY=<clave pública del proyecto>
LANGFUSE_SECRET_KEY=<clave secreta del proyecto>
LANGFUSE_TRACING_ENABLED=true
OBSERVABILITY_CONTENT_MODE=redacted
OBSERVABILITY_CONTENT_MAX_CHARS=4000
OBSERVABILITY_FILE_NAMES=false
OTEL_TRACES_SAMPLER=always_on
```

redacted exporta metadatos y medidas permitidas sin contenido. debug permite texto acotado y saneado; el presupuesto por input/output está limitado a 256..16000 caracteres, con 4000 por defecto. También se filtran secretos reconocidos, credenciales, Base64 y binarios. No es un anonimizador general: el texto permitido puede contener datos personales. Las opciones de depuración de logs del proveedor son independientes.

Los inputs/outputs de herramientas pasan por sanitizeContent y el filtro de exportación. La copia para telemetría no modifica lo que recibe el modelo o el chat. Las métricas de uso/coste conservan solo valores numéricos reconocidos, finitos y no negativos. Si Roko también contabiliza estos alias, su integración debe suprimir la contabilidad duplicada; el Bridge no puede configurar el exportador de Roko.

La generación `model.codex`/`model.claude` registra actualmente el alias solicitado, no una confirmación del modelo backend utilizado. Ni /health ni el alias visible en Langfuse demuestran qué modelo resolvió finalmente el proveedor.

## Correlación con Roko y MCP

Cada petición abre bridge.request, una generación del proveedor y observaciones de operaciones reales. Para aceptar un padre remoto se requiere un contexto firmado mediante OBSERVABILITY_TRACE_SECRET, de al menos 32 caracteres, compartido con los servicios participantes. Se comprueba además su vigencia máxima de 60 segundos y correspondencia de identidad. La autenticación normal de Roko sigue siendo obligatoria; el secreto de trazado no la sustituye.

Una cabecera traceparent arbitraria no puede elegir la traza. La identidad de inferencia mantiene su comprobación independiente de diez minutos. Las sesiones se seudonimizan por tenant/usuario/conversación; rotar la clave compartida cambia esa seudonimización.

Roko debe propagar el contexto a la URL real del Bridge y a los destinos MCP autorizados por su configuración. Para un árbol navegable común, los participantes deben exportar al mismo proyecto Langfuse. Con proyectos distintos pueden correlacionarse IDs, pero no hay un árbol unificado ni doble exportación automática.

No se envían claves Langfuse al modelo ni a herramientas externas. La configuración de trazado no amplía permisos de documentos, red ni herramientas MCP.

## Comprobar la instalación

1. Comprueba salud, login y sandbox por separado según [OPERATIONS.md](OPERATIONS.md).
2. Desde Roko, envía dos mensajes en una conversación. Verifica nuevas trazas por petición y la misma sesión seudonimizada. Otro usuario o tenant debe quedar separado.
3. Verifica bridge.request bajo el padre remoto cuando Roko firma el contexto. Sin propagación válida se espera una traza local.
4. Pide una operación de archivo y una función externa realmente disponible. Las tarjetas deben aparecer antes de terminar; no debe haber llamadas deducidas que no se ejecutaron.
5. Comprueba entrega y reapertura del archivo, validación disponible, intento 2 cuando corresponda y cierre de operaciones ante error/cancelación.
6. Con documentos sintéticos que contengan una cadena de control, revisa redacted y, si necesitas diagnosticarlo, debug. Comprueba límites y ausencia de credenciales/binarios en exportaciones; el chat sí puede mostrar detalles técnicos autorizados.
7. Comprueba que la respuesta sigue ejecutándose una sola vez si el exportador no está disponible. Haz estas pruebas con configuración de prueba; restaura el modo previsto al terminar.

Para comprobar únicamente conectividad y credenciales del proyecto desde Compose:

```bash
docker compose exec bridge node scripts/check-langfuse.mjs
```

No sustituye la inspección de spans ni una inferencia real. En una instalación gestionada por CI usa ci/compose.sh, según [DEPLOY.md](DEPLOY.md).

La exportación es asíncrona y de mejor esfuerzo. Langfuse normalmente recibe spans finalizados; no equivale al streaming del chat. Un crash o SIGKILL puede impedir su cierre y una caída prolongada puede perder telemetría. No se repite inferencia ni una herramienta para compensarlo. Cambiar políticas afecta nuevas exportaciones, no borra ni recupera el contenido de trazas anteriores.

Las pruebas usan el SDK Langfuse real y colectores OTLP locales. No acreditan la UI ni la configuración de tu instancia de producción: [TESTS.md](TESTS.md).