# Operación y solución de problemas

Esta guía reúne las comprobaciones habituales del bridge y cómo interpretar sus fallos. La especificación del contrato y los límites está en [SPEC.md](SPEC.md); los pasos de instalación están en [DOCKER.md](DOCKER.md) y [UBUNTU.md](UBUNTU.md).

## Comprobación rápida

En Docker:

```bash
docker compose ps
docker compose logs --tail=100 bridge
docker compose exec bridge bridge health
docker compose exec bridge bridge check:workspace
```

Ejecuta `docker compose exec bridge bridge check:sandbox` si utilizas Codex. En nativo, desde el directorio del proyecto:

```bash
npm test
npm run check:workspace
npm run check:sandbox
```

Los checks de sandbox se ejecutan en el host final. El test automatizado puede simular CLIs y no valida por sí mismo las restricciones del kernel, la cuenta del proveedor ni la conectividad entre contenedores.

## Diagnóstico por síntoma

| Síntoma | Qué comprobar |
| --- | --- |
| Roko no conecta con el bridge | Comprueba que ambos contenedores comparten `roko-cli-bridge`, que Roko usa `http://cli-bridge:4000/v1` y que `ROKO_BRIDGE_BASE_URL` coincide con el endpoint firmado. Para bridge nativo, usa la dirección alcanzable del host, no `localhost` desde otro contenedor. |
| Error de clave o contexto firmado | Compara `BRIDGE_API_KEY` con `CLAUDE_BRIDGE_KEY`; revisa que la URL configurada en Roko coincide exactamente con la URL firmada. Tras cambiar `.env`, recrea el contenedor con `docker compose up -d`. |
| `health` funciona, pero el modelo falla | `health` solo mide disponibilidad HTTP. Comprueba el login del proveedor elegido (`bridge claude auth status` o `bridge codex login status`) y ejecuta el check de sandbox correspondiente. |
| `login_required` o sesión caducada | Vuelve a autenticar ese proveedor dentro del mismo contenedor/usuario que ejecuta el servicio. En Docker, los logins están en el volumen `logins`; recrear la imagen no los copia desde el host. |
| `bwrap` o sandbox no disponible | En Docker, reconstruye con el `compose.yaml` del proyecto y ejecuta `bridge check:workspace`. Comprueba compatibilidad del kernel, Docker rootless y políticas de seguridad del host. En Ubuntu nativo, confirma que bubblewrap está instalado. Si el check falla, la shell se bloquea y no hay modo sin sandbox. |
| Windows `CreateProcessAsUserW` falla | Ejecuta `npm run check:sandbox` desde la cuenta que ejecuta el bridge, revisa la configuración de `CODEX_WINDOWS_SANDBOX` y las políticas de Windows. El modo elevado necesita preparación administrativa. |
| No aparece el documento editado | Revisa que el proveedor guardó el entregable final bajo `outputs/`, lo declaró en el resultado y que el archivo no está vacío ni excede el límite. Mira los logs del bridge y de Roko; el workspace se elimina al terminar la petición y no es almacenamiento persistente. |
| Archivo rechazado o sin lectura | Comprueba tamaño, extensión/MIME y dependencias instaladas. El original puede transportarse aunque no exista lector o editor para su formato. Los límites efectivos también dependen de Roko y del cliente web. |
| Puerto ocupado al iniciar Compose | Cambia `BRIDGE_PUBLISHED_PORT` en `.env` para el acceso local de diagnóstico. La comunicación entre contenedores sigue usando `cli-bridge:4000`. |

## Logs

En Docker usa `docker compose logs -f bridge`; en systemd, `journalctl --user -u ai-librechat-bridge.service -f`. En ejecución manual, observa la terminal donde ejecutaste `npm start`.

Por defecto los logs limitan los detalles y no imprimen bytes de adjuntos. `BRIDGE_DEBUG_ATTACHMENTS=1` añade nombres, MIME y tamaños de archivos; `BRIDGE_DEBUG_PROVIDER=1` puede incluir comandos o salida acotada del proveedor. Activa esos valores solo para diagnosticar localmente, revisa los logs y vuelve a desactivarlos. No compartas logs que puedan contener prompts, nombres de archivos, rutas o salida del modelo.

## Persistencia y copias

El bridge usa los datos persistentes para credenciales de proveedor y ejecución local. En Docker, `docker compose down` conserva volúmenes y `docker compose down -v` los borra. Guarda una copia segura de `.env` y exporta los volúmenes necesarios antes de migrar o borrar la instalación. Las credenciales son secretos: limita quién puede leer las copias.

Roko es quien conserva conversaciones y archivos reutilizables. Haz copias de seguridad de MongoDB, del almacenamiento de archivos y de los demás volúmenes de Roko con el procedimiento propio de ese despliegue. El workspace temporal del bridge no reemplaza esas copias ni permite reabrir archivos de una petición anterior.

## Reiniciar y actualizar

Después de cambiar variables de entorno o configuración, recrea el servicio. Para actualizar código en Docker, conserva `.env` y ejecuta `docker compose up -d --build`; luego corre los checks para los proveedores activos. Para la instalación nativa, instala las dependencias fijadas con `npm ci` y actualiza el entorno de archivos con `npm run setup:files`.

Evita dos procesos activos que compartan las mismas credenciales de proveedor. Antes de eliminar volúmenes o rotar la clave compartida, actualiza la configuración del bridge y Roko de forma coordinada.
