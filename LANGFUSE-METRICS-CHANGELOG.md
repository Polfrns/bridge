# Hotfix de métricas Langfuse — 2026-10-16

## Bridge

- Conserva en la copia de exportación los mapas numéricos usage_details/cost_details.
- Rechaza valores inválidos, objetos anidados, texto y campos desconocidos.
- Añade regresiones y pruebas del SDK real contra un colector OTLP local.
- Mantiene Bridge 0.7.3, protocolo Responses y dependencias sin cambios.

## Roko

- Conserva métricas numéricas en el exportador protegido.
- Marca los seis alias conocidos como bridge_replica al exportar desde Roko;
  su uso/coste cero explícito impide sumar o inferir dos veces la misma llamada.
- Conserva las observaciones y el consumo de modelos directos.
- Amplía tests de privacidad y documentación SPEC/TESTS.

## Filestore

Sin cambios. Este servicio no origina las generaciones de Codex/Claude cuyos
contadores se corrigen. Se conserva su despliegue en la VM separada.

## Operación

- Aplicador con verificación de versiones, soporte CRLF e idempotencia.
- Guía de push/CI/despliegue, precios, dashboards, anotaciones, alertas y rollback.
- No se añaden credenciales, variables obligatorias ni procesos de IA.
- Las puntuaciones automáticas nuevas no están implementadas; la guía distingue
  configuración manual, datos ya emitidos y futuras integraciones.
