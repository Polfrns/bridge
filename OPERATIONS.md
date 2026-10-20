# Operación y diagnóstico

Para instalar usa [DOCKER.md](DOCKER.md) o [UBUNTU.md](UBUNTU.md). En producción gestionada por CI, ejecuta los comandos Compose mediante ci/compose.sh para conservar la imagen y definiciones fijadas: [DEPLOY.md](DEPLOY.md).

## Comprobación rápida

En una instalación Compose local:

```bash
docker compose ps
docker compose logs --tail=100 bridge
docker compose exec bridge bridge health
docker compose exec bridge bridge claude auth status
docker compose exec bridge bridge codex login status
docker compose exec bridge bridge check:workspace
docker compose exec bridge bridge check:sandbox
```

Ejecuta solo los comandos de los proveedores que utilices. En nativo, los checks son npm run check:workspace y npm run check:sandbox.

health comprueba vida HTTP y capacidades declaradas, no autenticación ni sandbox. check:workspace prueba el ejecutor restringido de Claude sin login/inferencia; si existe toolkit, también edita y valida DOCX. check:sandbox prueba el sandbox nativo sin llamar al modelo; su preparación usa credenciales Codex. Las restricciones deben comprobarse con el usuario y host reales.

## Diagnóstico

| Síntoma | Comprobación |
| --- | --- |
| Roko no conecta | Misma red roko-cli-bridge y URL http://cli-bridge:4000/v1. Desde otro contenedor localhost apunta al propio contenedor. Para ejecución nativa usa la dirección alcanzable del host. |
| Bearer o HMAC inválido | Misma BRIDGE_API_KEY/CLAUDE_BRIDGE_KEY, contexto firmado por el backend y reloj correcto. La URL autorizada para propagación debe coincidir con la configurada en Roko. |
| health responde pero falla inferencia | Login del proveedor, acceso al modelo backend y check del sandbox por separado. |
| login_required | Reautentica dentro del contenedor/usuario del servicio; reconstruir no importa los logins del host. |
| bwrap/sandbox rechazado | Kernel y perfiles Docker, bubblewrap en nativo y check:workspace. No se ejecuta shell sin aislamiento. |
| Windows exige sandbox elevado | Revisa CODEX_WINDOWS_SANDBOX y la preparación administrativa del backend; unelevated puede no satisfacer la restricción de lecturas de Claude. |
| No aparece el archivo | Debe existir bajo outputs/, estar declarado, cambiado, no vacío y dentro de límites. Revisa también dependencias del validador y descarga en Roko. |
| validationStatus=unavailable/partial | Faltan comprobaciones del toolkit; no equivale a validación estructural completa. |
| response ID desconocido | Estado Responses expirado, reiniciado o de otro propietario. Reenvía historial compatible desde Roko. |
| request_timeout / HTTP 504 | El default es diez minutos. Ajusta REQUEST_TIMEOUT_MS si el trabajo lo requiere y recrea; revisa también límites del cliente/proxy. |
| Prueba falla durante docker build | La etapa ci es obligatoria. Consulta el primer test fallido y [TESTS.md](TESTS.md); el fallo bloquea la imagen de producción. |

## Aplicar modelos y cambios de configuración

Los valores de .env.example son una plantilla. La instalación lee .env y el entorno del proceso. Revisa perfiles, variables FAST/DEEP, allowlists y opciones enviadas por Roko: [SPEC.md](SPEC.md).

En Compose local, tras cambiar código:

```bash
docker compose up -d --build
```

Tras cambiar solo .env, recrea sin reconstruir:

```bash
docker compose up -d --no-deps --force-recreate bridge
```

En producción CI sigue [DEPLOY.md](DEPLOY.md), conservando la imagen aprobada. En nativo reinicia el proceso con el nuevo entorno; tras actualizar dependencias usa npm ci y npm run setup:files.

## Verificar streaming y modelo

Desde Roko pide una respuesta textual suficientemente larga. El texto aparece cuando el SDK comunica fragmentos compatibles; un bloque completo único puede ser la granularidad real. Las tarjetas deben actualizarse durante operaciones. Las respuestas con archivos esperan validación y pueden mostrar actividad antes de la entrega.

Comprueba /health y las capacidades reasoningReplay/publicProgress/liveText/cliOptions para detectar imágenes antiguas, sin tomar esas banderas como una prueba integral.

Los alias de /v1/models o Langfuse no prueban el modelo backend utilizado. La generación Langfuse registra actualmente el alias solicitado. Una confirmación real requiere un dato de modelo reportado por el proveedor; esta versión no expone un diagnóstico unificado de modelo efectivo. Revisar .env solo confirma la intención configurada.

## Logs y privacidad

Usa docker compose logs -f bridge o journalctl --user -u ai-librechat-bridge.service -f en el servicio nativo. BRIDGE_DEBUG_ATTACHMENTS=1 añade nombres/MIME/tamaños; BRIDGE_DEBUG_PROVIDER=1 puede incluir comando y salida acotados. Son opciones de diagnóstico local, independientes del modo Langfuse.

Las tarjetas pueden incluir detalles técnicos de herramientas dentro del chat autenticado. redacted/debug controla su exportación, no lo que se muestra al usuario. Consulta [OBSERVABILITY.md](OBSERVABILITY.md).

## Persistencia y copias

En Compose los volúmenes logins y runtime sobreviven a down; down -v los elimina. Conserva copias privadas de .env y credenciales y evita varias instancias usando el mismo directorio OAuth.

Roko conserva conversaciones, MongoDB y archivos persistentes. Su backup debe seguir el procedimiento de ese despliegue. Los workspaces temporales del Bridge no sirven para restaurarlos ni recuperar una edición de otra petición.