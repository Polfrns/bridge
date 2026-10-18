# Pruebas del hotfix de métricas — 2026-10-16

Base: Bridge 0.7.3 y actualización de observabilidad Roko 0.7.2.
Node 24.19.0. Ninguna prueba consulta un modelo o un Langfuse remoto.

## Ejecutadas y superadas

| Conjunto | Resultado |
| --- | --- |
| Bridge: `FILE_TEST_PYTHON=<venv>/bin/python sh ci/test.sh` | 145 Node + 9 Python, 0 fallos, 0 omitidas |
| Roko: `node --test scripts/observability.test.cjs scripts/content-privacy.test.cjs` | 11 superadas, 0 fallos, 0 omitidas |
| Aplicador: preflight, aplicación, idempotencia, conflicto sin escrituras, CRLF y rechazo de symlink | 5 superadas |

Total de los conjuntos anteriores: 170 pruebas. Las 2 pruebas con SDK real y
colector OTLP local están incluidas en las 145 de Bridge, no se cuentan otra vez.
Comprueban uso/coste numérico, privacidad y consumo cero de la réplica de Roko.
Las políticas exportadas de Roko y Bridge son idénticas byte a byte.

La ejecución de Roko reutilizó `@opentelemetry/api` ya instalado en Bridge con
NODE_PATH. No se instaló todo el monorepo ni se ejecutó su CI completa.

## Regresión confirmada y fallos resueltos

Las nuevas aserciones de metering se ejecutaron con la política anterior y
fallaron: se perdían usage_details y cost_details. Con la política nueva pasan.
Una ejecución inicial de Roko falló por ausencia de @opentelemetry/api; se repitió
con la dependencia disponible y pasó.

La primera ejecución completa de Bridge tuvo 4 fallos de las pruebas de archivos:
el Python de un entorno temporal anterior apuntaba a un binario inexistente.
Se creó un venv funcional, se instalaron py7zr/pillow-heif y se repitió toda la
suite: 145 Node + 9 Python superadas. No se desactivaron ni omitieron esos tests.
No se cambió ninguna dependencia del repositorio para preparar el entorno local.

## No ejecutadas aquí

- CI completa de Roko (Jest del cliente/API y parches de agents con sus deps).
- Builds Docker y comprobaciones sobre el daemon de producción.
- Push, pipeline Bitbucket o despliegue en las VM del usuario.
- Pruebas con modelos Codex/Claude reales o el MCP de producción.
- Configuración de precios, dashboards, colas o alertas en el Langfuse del usuario.

Esas verificaciones se indican en GUIA-LANGFUSE.md. No se presentan como pasadas.
