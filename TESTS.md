

## Observabilidad v0.7.1

Observabilidad v0.7.1 protege clasificación, ciclo de vida, agrupación de sesiones, contexto de servicio autenticado y privacidad antes de OTLP. Véanse TEST-RESULTS.md para comandos/resultados y VERIFY-LANGFUSE.md para verificación de despliegue.


## Observabilidad v0.7.2

Entrada y salida textual acotada en observaciones existentes, según modo redacted/debug. El contexto remoto firmado conserva nombre de la traza raíz. Filtro de secretos/binarios también en debug; nuevas pruebas HTTP con SDK/OTLP reales. Versión de servicio 0.7.2, dependencias sin cambios.

Las pruebas nuevas comprueban límites de contenido, filtrado antes de exportar y no mutación de datos. Roko ejecuta processStream real sobre un grafo de prueba y comprueba trazas, títulos, usuarios, errores y cancelación. Bridge verifica por HTTP la firma y el padre remoto con SDK real. Filestore mantiene sus 12 herramientas y pruebas de acceso. Véanse TEST-RESULTS.md y OBSERVABILITY-V072.md.
