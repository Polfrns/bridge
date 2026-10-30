# Instalación con Docker Compose

Esta guía instala el bridge en Linux o Windows con Docker Compose. En Windows, Docker Desktop debe usar contenedores Linux. La imagen contiene el runtime Node, los SDK de Claude y Codex y las herramientas de archivos incluidas en el Dockerfile; no hace falta instalar Node o Python en el host.

Describe una instalación Compose local. Para producción con GitHub Actions y una imagen aprobada por digest, sigue [DEPLOY.md](DEPLOY.md) para actualizar o recrear conservando esa imagen. La versión declarada es 0.7.3; consulta [CHANGELOG.md](CHANGELOG.md) para los cambios posteriores del repositorio.

## Requisitos

- Docker Engine y el complemento Docker Compose en Linux, o Docker Desktop en Windows.
- Acceso a internet durante la primera construcción.
- Una cuenta y sesión autorizada para cada proveedor que se vaya a utilizar.
- El repositorio o ZIP portable completo, con `compose.yaml`, `Dockerfile` y `package-lock.json` en la raíz.

## Preparar e iniciar

En Linux:

```bash
mkdir -p ~/ai-librechat-bridge
# Extrae el contenido del ZIP dentro de esa carpeta.
cd ~/ai-librechat-bridge
cp .env.example .env
chmod 600 .env
```

En Windows, extrae el ZIP en una carpeta local y abre PowerShell en esa carpeta. Copia `.env.example` como `.env` si todavía no existe.

Edita `.env` y asigna `BRIDGE_API_KEY`. Debe ser la misma clave que Roko usa como `CLAUDE_BRIDGE_KEY`. Si aún no tienes una clave, genera una de 32 bytes aleatorios, por ejemplo en Linux con `openssl rand -hex 32` o en PowerShell con:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

Guarda el mismo valor en ambos `.env`. Mantén privados estos archivos. Después construye e inicia:

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 bridge
```

## Iniciar sesión y validar

Autentica solo los proveedores que vayas a usar. Los logins se guardan en el volumen Docker `logins`, no se copian automáticamente desde el host.

```bash
# Codex, si lo vas a utilizar
docker compose exec bridge bridge codex login --device-auth
docker compose exec bridge bridge codex login status
docker compose exec bridge bridge check:sandbox

# Claude, si lo vas a utilizar
docker compose exec bridge bridge claude auth login
docker compose exec bridge bridge claude auth status
docker compose exec bridge bridge check:workspace

# Salud HTTP local
docker compose exec bridge bridge health
```

El login de dispositivo de Codex puede requerir que la cuenta o el administrador permitan ese método. `check:workspace` prueba el sandbox de shell de Claude sin login ni inferencia y añade una prueba DOCX si existe el toolkit. `check:sandbox` es una prueba nativa determinista, sin llamada al modelo, aunque prepara un runtime que requiere credenciales Codex. `health` solo confirma vida HTTP, versión y capacidades declaradas. Si el navegador no puede completar el callback de Claude dentro del contenedor, sigue el código o URL que indique el CLI.

## Conectar Roko/LibreChat

Si Roko está en otro proyecto Compose del mismo host, ambos servicios deben compartir la red `roko-cli-bridge`. El bridge la crea y ofrece el alias `cli-bridge`. Desde el contenedor de Roko, la URL base es:

```text
http://cli-bridge:4000/v1
```

Integra [config/roko-docker-network.patch.yaml](config/roko-docker-network.patch.yaml) bajo el servicio `api` del override existente. Conserva sus redes y añade la red del bridge. Configura `ROKO_BRIDGE_BASE_URL` en Roko y los `baseURL` de los endpoints personalizados con la misma URL. En `runtime-config.yaml`, conserva `apiKey: "${CLAUDE_BRIDGE_KEY}"` y asegúrate de que la clave coincide con `BRIDGE_API_KEY`.

Consulta los fragmentos [runtime-config.bridge.yaml](config/runtime-config.bridge.yaml) y [librechat.example.yaml](config/librechat.example.yaml). Son ejemplos parciales; intégralos en la configuración efectiva de Roko, no los uses como reemplazo completo.

Aplica los cambios desde la carpeta de Roko y comprueba conectividad:

```bash
docker compose up -d api
docker compose exec api node -e "fetch('http://cli-bridge:4000/health').then(async r => { console.log(await r.text()); if (!r.ok) process.exitCode = 1 }).catch(e => { console.error(e.message); process.exitCode = 1 })"
```

El puerto publicado del bridge está ligado a `127.0.0.1` y sirve para diagnóstico desde el host. Los contenedores de Roko deben usar el alias de red, no `localhost`. Si Roko está en otra máquina o fuera de Docker, configura una dirección alcanzable, limita el acceso con firewall y no expongas el servicio directamente a internet.

## Persistencia, actualización y eliminación

Compose conserva las sesiones de proveedor en `logins` y los datos temporales en `runtime`. `docker compose down` detiene y elimina contenedores, pero mantiene esos volúmenes. **`docker compose down -v` elimina también los logins y los datos persistidos**.

Para actualizar el código, conserva `.env` y vuelve a construir:

```bash
docker compose up -d --build
docker compose exec bridge bridge check:workspace
```

Ejecuta también `bridge check:sandbox` si usas Codex. Para aplicar únicamente cambios de `.env`, ejecuta `docker compose up -d --no-deps --force-recreate bridge`; un `restart` no carga el entorno nuevo. Cambiar `.env.example` no modifica la instalación activa. El timeout predeterminado es de diez minutos; los modelos y perfiles se resuelven según [SPEC.md](SPEC.md). No ejecutes dos instancias del bridge con el mismo directorio de login al mismo tiempo.

La construcción instala las dependencias del lockfile y ejecuta obligatoriamente `ci/test.sh` en la etapa `ci`, de la que hereda `production`. Si falla una prueba no se produce la imagen final. Para construir solo la etapa de comprobación, sigue [TESTS.md](TESTS.md).

Los chats, agentes y archivos persistentes pertenecen a Roko y a sus volúmenes. El workspace del bridge es temporal por petición y no reemplaza las copias de seguridad de Roko. Para migrar el despliegue, migra por separado las bases de datos/archivos de Roko y restaura o vuelve a autenticar los proveedores.

## Sandbox en Docker

El compose activa capacidades y perfiles específicos para permitir el sandbox Linux anidado de bubblewrap. El servicio no usa `privileged` ni monta el socket Docker. Algunas combinaciones de kernel, Docker rootless, VM o políticas del host pueden impedir el sandbox. En ese caso, el check falla y la ejecución de shell queda bloqueada; no se ejecuta sin aislamiento. Valida el sandbox en el host final antes de usarlo.

Para solución de problemas y operación diaria, consulta [OPERATIONS.md](OPERATIONS.md). Para el modo nativo, consulta [UBUNTU.md](UBUNTU.md).
