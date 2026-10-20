# Límites y cobertura real

## API y modelos

El bridge adapta los runtimes CLI fijados por el proyecto, no toda la API de OpenAI o Anthropic. File Search y Code Interpreter alojados no están implementados. Las funciones externas deben exponerse desde Roko y ejecutarse allí.

Los alias y esfuerzos configuran opciones, pero no garantizan disponibilidad ni calidad de un modelo para una cuenta concreta. El campo model de la generación Langfuse contiene actualmente el alias del bridge; no confirma el modelo backend resuelto por el SDK.

La continuación Responses vive en memoria con TTL y propietario. No persiste tras reinicio. reasoning replay conserva el transporte compatible, pero no descifra estado interno ni retoma una sesión privada del modelo.

## Streaming

Solo se transmite prosa incremental cuando el SDK expone fragmentos compatibles y el sobre permite identificar una respuesta ordinaria. Un mensaje completo puede llegar como un solo bloque; no se fabrican tokens.

Archivos, unsupported y funciones esperan revisión estructural. El texto ya emitido no puede retirarse: un fallo posterior termina con error, sin prometer éxito ni reescribirlo mediante reparación.

Las tarjetas son presentación de operaciones observadas, no instrucciones ejecutables. Un cliente antiguo puede necesitar actualizar el parser para los campos y presupuestos del V1 ampliado.

## Archivos y herramientas

La extensión/MIME reconocida no implica lector, editor o validador completo. Los límites están en [SPEC.md](SPEC.md); Base64 también cuenta para el cuerpo HTTP.

La validación puede ser checked, partial o unavailable según el toolkit. Que un archivo pase la comprobación estructural no garantiza exactitud de contenido, diseño, fórmulas o macros. La conversión Office puede perder funciones propietarias; XLSB no tiene escritor dedicado. Transcripción necesita pesos locales previamente instalados.

Producir un EXE Windows requiere una herramienta adecuada para ese destino. Las instrucciones exigen comprobar la cadena de compilación y explicar las partes no disponibles; un binario Linux o un fuente no son un EXE Windows validado.

Los workspaces son temporales. Roko debe conservar y volver a adjuntar la última versión para continuar una edición.

## Aislamiento

El sandbox comparte kernel y usuario de servicio con su entorno; no equivale a una VM dedicada. Docker declara SYS_ADMIN y excepciones seccomp/AppArmor para permitir namespaces anidados, sin privileged ni socket Docker.

Kernel, rootless, políticas de VM y configuración Windows pueden impedir las restricciones requeridas. Los checks reales deben pasar en el host final; no hay fallback de shell sin aislamiento. No ejecutes varias instancias con el mismo directorio de login: el bloqueo de credenciales es interno al proceso.

La limpieza y cierre de observaciones cubren el flujo normal de error/cancelación. Un crash o terminación forzada puede impedirlos.

## Observabilidad

Los SDK no muestran todas las operaciones internas de una shell ni cada reintento de red/modelo. No se inventan lecturas, escrituras, descargas ni tiempos a partir de palabras en un comando.

Un tiempo observed mide el intervalo entre eventos recibidos, no la duración nativa garantizada. Un terminal sin inicio no permite reconstruir duración. Los reintentos de reparación conocidos sí se distinguen.

El chat puede mostrar detalles técnicos reales de herramientas. El modo de privacidad de Langfuse no los oculta en la conversación. debug exporta texto saneado y acotado, pero no constituye anonimización general.

La exportación es asíncrona, acotada y de mejor esfuerzo. Una caída puede perder telemetría; no provoca repetición de inferencia o herramientas. Proyectos Langfuse distintos no forman un árbol único y las trazas antiguas no cambian al modificar la política.

Consulta [OBSERVABILITY.md](OBSERVABILITY.md) y los resultados y comprobaciones pendientes en [TESTS.md](TESTS.md).