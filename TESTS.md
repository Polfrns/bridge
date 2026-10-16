

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
