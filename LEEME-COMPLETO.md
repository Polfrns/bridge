# Bridge completo — 18/10/2026

Este ZIP contiene el repositorio completo conocido en este chat, no solo un parche.
Base: Bridge 0.7.3 con corrección de Responses reasoning.
Se ha incorporado el hotfix de contadores Langfuse y deduplicación de consumo.
No incluye cambios posteriores de otros clones que no se hayan compartido aquí.

Consulta LANGFUSE-METRICS-GUIA-LANGFUSE.md para configuración de métricas y precios,
y LANGFUSE-METRICS-TEST-RESULTS.md para pruebas ejecutadas y pendientes.
El empaquetado no cambia dependencias ni la versión del paquete.

No se incluyen .env privados, credenciales, node_modules, .git ni datos de usuarios.
Conserva tu configuración privada antes de copiar a un despliegue existente.
Los Compose y pipelines se conservan: otro servidor requiere adaptar su configuración.
La retención automática de imágenes actual/anterior todavía no está implementada.
