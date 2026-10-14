# Bridge v0.7.0: Langfuse y actividad visible en LibreChat

## Cambios

- Langfuse SDK v5 y OpenTelemetry, por variables de entorno, con fallos de telemetría tolerados sin ejecutar dos veces Codex/Claude.
- Spans por petición y ejecución del modelo, tokens cuando estén disponibles, usuario/sesión seudonimizados.
- Eventos internos de herramientas Codex/Claude como estados *seguros* en streaming de Chat Completions (`reasoning_content`).
- Se mantienen intactos la devolución de archivos, relay de herramientas MCP, sandbox, permisos, límite de concurrencia y streaming del mensaje final.
- Reparación de las pruebas preexistentes que asumían sintaxis anterior y una mejora real de la decodificación de continuación de herramientas en `src/protocol.mjs`.

## Variables de entorno (`.env`, NUNCA versionar claves)

```dotenv
LANGFUSE_BASE_URL=http://IP-LANGFUSE:3000
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_TRACING_ENABLED=true
BRIDGE_ACTIVITY_ENABLED=true
```

El `compose.yaml` ya tiene `env_file: .env`. No hace falta publicar el puerto 4000 hacia fuera: mantener `127.0.0.1:4000`. Los paquetes Langfuse están fijados a versiones concretas en el Dockerfile; el `package-lock.json` original se utiliza para las dependencias base. Si se prefiere gestionar todo en un solo lockfile, ejecutar `npm install --package-lock-only @langfuse/tracing@5.13.1 @langfuse/otel@5.13.1 @opentelemetry/sdk-node@0.223.0` en un entorno con npm disponible y sustituir el paso adicional del Dockerfile por `npm ci`.

## Desplegar

```bash
cd ~/services/bridge
docker compose config -q
docker compose build bridge
docker compose run --rm --no-deps --entrypoint node bridge scripts/check-langfuse.mjs
docker compose up -d --no-deps bridge
docker compose ps
docker compose logs --tail=80 bridge
curl -fsS http://127.0.0.1:4000/health
```

No ejecutar `docker compose down -v`; preserva `logins` y `runtime`.

## Límites y privacidad

- Las actividades se muestran como líneas en la sección de razonamiento/actividad, **no** como `tool_calls` ejecutables de MCP.
- No se reproduce el pensamiento privado del modelo. Ninguna línea incluye comandos, argumentos de herramientas, contenido de documentos o nombres de archivo.
- El estado se envía en tiempo real para Chat Completions; la API Responses solo incorpora los estados al final de la ejecución.
- El volumen se limita a 120 actualizaciones por solicitud para no saturar el cliente.
- Para que Roko las muestre, necesita `includeReasoningContent` activado (incluido en el parche Roko).
