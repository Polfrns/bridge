# Instalación nativa en Ubuntu y Windows

Esta guía es para ejecutar Node directamente en el host, sin Docker. En producción, Docker Compose suele simplificar las dependencias: consulta [DOCKER.md](DOCKER.md). No reutilices `node_modules`, `runtime-tools`, rutas ni credenciales nativas de Windows en Ubuntu, ni a la inversa.

Describe el código actual con versión declarada 0.7.3. Los cambios locales posteriores están en [CHANGELOG.md](CHANGELOG.md). Para el pipeline de producción usa [DEPLOY.md](DEPLOY.md).

## Requisitos comunes

- Node.js 22 o superior, con npm.
- Python 3.10 o superior para lectores, edición y validación de documentos.
- Una instalación local por sistema operativo; el `package-lock.json` fija las dependencias de Node.
- Permisos para ejecutar el sandbox del proveedor en el host.

LibreOffice, FFmpeg, Tesseract, pandoc y Graphviz son opcionales. Instálalos solo si necesitas conversión de Office, análisis de audio/vídeo, OCR, conversión de documentos o diagramas. El toolkit Python básico instala bibliotecas para imágenes, PDF, formatos Office, datos (pandas/numpy), gráficos (matplotlib) y creación de PDF (reportlab/WeasyPrint). WeasyPrint necesita Pango del sistema; en Windows suele faltar y `setup:files` lo avisa sin fallar.

## Ubuntu

Instala Node 22+, Python, bubblewrap y los paquetes de sistema que necesites. Ejemplo de dependencias disponibles en Ubuntu:

```bash
sudo apt update
sudo apt install -y python3 python3-venv bubblewrap ca-certificates \
  libreoffice-writer libreoffice-calc libreoffice-impress \
  ffmpeg tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa fonts-dejavu-core \n  pandoc graphviz libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0
```

Desde la carpeta del proyecto:

```bash
npm ci
npm run setup
npm run setup:files
```

`npm run setup` crea `.env` con una clave aleatoria solo si todavía no existe. Comparte esa clave con `CLAUDE_BRIDGE_KEY` en Roko. Para que Roko en Docker alcance el proceso nativo del host Ubuntu, ejecuta:

```bash
npm run setup:ubuntu
```

El script requiere Docker Engine activo y acceso del usuario a `docker network inspect bridge`. Detecta la puerta de enlace usada por Docker y actualiza `BRIDGE_HOST` en `.env`, preservando la clave y las demás opciones. Integra también [config/compose-override.patch.yaml](config/compose-override.patch.yaml) en el override existente de Roko para añadir `host.docker.internal:host-gateway`; usa esa misma URL alcanzable en `runtime-config.yaml` y `ROKO_BRIDGE_BASE_URL`. No configures `127.0.0.1` como dirección de un bridge nativo al que deba conectarse otro contenedor.

Autentica solo los proveedores requeridos. En Ubuntu, usa los binarios fijados por el proyecto:

```bash
node scripts/container-cli.mjs claude auth login
node scripts/container-cli.mjs codex login --device-auth
```

Comprueba el entorno y arranca:

```bash
npm run check:workspace
npm run check:sandbox
npm test
npm start
```

`check:workspace` valida el sandbox restringido de Claude, sin login ni inferencia; añade una comprobación DOCX si existe toolkit. `check:sandbox` valida el sandbox nativo de Codex sin llamar al modelo; su preparación usa credenciales Codex. Ejecuta los checks en la misma máquina y con el mismo usuario que ejecutará el bridge. `npm test` ejecuta solo Node; la suite completa Linux con Python está en [TESTS.md](TESTS.md).

### Arranque automático con systemd (opcional)

La plantilla [config/ai-librechat-bridge.service](config/ai-librechat-bridge.service) es un servicio de usuario. Copia el archivo, actualiza `WorkingDirectory` y la ruta de `node` con los valores reales de tu instalación, y después habilítalo:

```bash
mkdir -p ~/.config/systemd/user
cp config/ai-librechat-bridge.service ~/.config/systemd/user/
# Edita las rutas con: nano ~/.config/systemd/user/ai-librechat-bridge.service
systemctl --user daemon-reload
systemctl --user enable --now ai-librechat-bridge.service
systemctl --user status ai-librechat-bridge.service
```

Para que el servicio de usuario pueda arrancar al iniciar el host sin sesión abierta, habilita linger para tu usuario: `sudo loginctl enable-linger "$USER"`. Usa el mismo usuario que realizó el login de los proveedores.

## Windows

Instala Node.js 22+, Python 3.10+ y PowerShell. Abre PowerShell en la carpeta del proyecto:

```powershell
npm ci
npm run setup
npm run setup:files
```

Instala los CLIs nativos de los proveedores que vayas a usar y autentícalos en la misma cuenta de Windows que ejecutará el bridge. Después ejecuta las pruebas:

```powershell
claude auth login
codex login
npm run check:workspace
npm run check:sandbox
npm test
npm start
```

Para el login de Codex, usa el método que admita la cuenta y el CLI instalado. El sandbox Codex puede funcionar en modo no elevado; la restricción de lecturas exigida por el ejecutor de Claude puede requerir un backend elevado. `CODEX_WINDOWS_SANDBOX=elevated` necesita la preparación y permisos de administrador del sandbox. Si la comprobación falla, no hay fallback sin aislamiento. La suite nativa Windows tiene limitaciones de plataforma y dependencias descritas en [TESTS.md](TESTS.md).

Si el bridge nativo corre en Windows y Roko está en Docker Desktop en el mismo host, configura Roko para usar `http://host.docker.internal:4000/v1` y define `BRIDGE_HOST` en `.env` con una interfaz accesible desde Docker. Restringe el acceso al puerto en el firewall de Windows a la red necesaria. Si ambos se ejecutan en Docker, sigue [DOCKER.md](DOCKER.md).

## Actualizar el entorno Python

Tras actualizar el proyecto, vuelve a ejecutar `npm ci` y `npm run setup:files`. Para habilitar transcripción multimedia, instala el extra opcional `npm run setup:files -- --media` y configura `BRIDGE_WHISPER_MODEL` con la ruta a un modelo Faster-Whisper que ya esté disponible localmente. No se descarga un modelo durante una petición.

Para conservar credenciales, `.env` y el directorio de login del proveedor, guarda copias seguras fuera del repositorio. No sincronices esas rutas entre sistemas operativos.

Tras cambiar `.env`, reinicia el proceso Node con el entorno actualizado. El archivo de ejemplo no se aplica automáticamente. Los modelos, perfiles y esfuerzos actuales están en [README.md](README.md) y su precedencia en [SPEC.md](SPEC.md). Para actividad y Langfuse sigue [OBSERVABILITY.md](OBSERVABILITY.md).
