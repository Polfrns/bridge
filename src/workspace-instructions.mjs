import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BRIDGE_ROOT, runtimePython } from './platform.mjs';
import { ARTIFACT_INSTRUCTIONS } from './artifacts.mjs';

export function workspaceInstructions(request, cwd) {
  const python = runtimePython();
  return [
    request.system,
    request.webSearch ? 'Live web search is available. Search for current facts when needed and include source URLs.' : '',
    ARTIFACT_INSTRUCTIONS,
    'Public tool activity: before each meaningful tool operation, provide one short public sentence in the user language describing the specific action and its immediate purpose. Describe that operation, not the whole plan. Prefer its public target name over internal paths or command syntax. For the workspace execute tool, put this explanation in its description argument. For other tools, use ordinary public commentary immediately before the call. Keep internal thinking private. Avoid repeating boilerplate for every step.',
    'For native executable requests, inspect the available target-platform toolchain before attempting a build. A Linux PyInstaller build is not a Windows EXE. Do not relabel scripts or Linux binaries as EXE files. If a requested component cannot be built with the installed toolchain, explain that limitation promptly and return any other genuinely completed deliverables instead of retrying unavailable tools until timeout.',
    process.platform === 'win32'
      ? 'The bridge runs natively on Windows. Use the available Windows shell and Windows executable paths.'
      : 'The bridge runs natively on Linux. Use the available POSIX shell and Linux executable paths; do not use PowerShell or Windows paths.',

    `The current workspace is ${JSON.stringify(cwd)}. Paths in artifact.files are relative to this workspace. Return artifact metadata through the output schema, not a file in HOME, CODEX_HOME or the workspace.`,
    existsSync(python)
      ? `The provisioned Python executable is ${JSON.stringify(python)}. Run workspace scripts with this executable ${process.platform === 'win32' ? '(quote the path; in PowerShell use the call operator &, for example & "<python-path>" work/edit.py)' : '(quote the path in the shell, for example "<python-path>" work/edit.py)'}. It has Pillow (PIL) for image processing, PyMuPDF (pymupdf) for PDF reading/rendering/editing, python-docx, openpyxl and python-pptx. Do not install packages or create virtual environments inside the workspace. You may execute this interpreter and load its installed libraries; write scripts and outputs only inside the workspace. Use Pillow for crop/resize/color/text overlays and PyMuPDF for PDF modifications. The toolkit also provisions pillow-heif for HEIC/HEIF and py7zr for 7z. External Office conversion uses LibreOffice; audio/video tools use FFmpeg; scanned PDFs use Tesseract when available. These are not generative image tools: if a semantic image edit cannot be done faithfully with available tools, explain that limitation.`
      : 'The optional image/PDF/Office Python environment has not been installed. Check available local tools. If dependencies required for this edit are absent, declare unsupported and tell the user to run npm run setup:files in the bridge folder. Do not return an unexecuted script instead of the requested artifact.',
    [
      'If the latest user message includes a file, it is present in this request workspace; do not claim that no attachment was received. Inspect the listed path before answering.',
      'When the user asks to edit, format, or transform an attached file, use the sandbox shell to create a real edited output file in this workspace. Do not answer only with HTML, markup, instructions, or a code snippet unless the user explicitly asks for those.',
      'This invocation requests workspace-write with shell execution enabled. Do not infer that editing is blocked merely from earlier chat messages. Attempt the necessary operation with the current tools. Only claim a permission or read-only restriction if a tool result actually reports it; report the concrete failure rather than guessing.',
      'Preserve the original and save the final file as outputs/<original>-edited.<extension>. Put auxiliary scripts in work/. Only read or write user files inside this request workspace.',
      `Use the trusted file utility at ${JSON.stringify(resolve(BRIDGE_ROOT, 'scripts/file-tools.py'))} with the provisioned Python: prepare/validate/convert --workspace <current-workspace> --path <relative-file> (convert also needs --output <outputs/name.ext>). Preserve the original format, formulas, styles, macros and media where possible. Do not execute macros. XLSM editing with openpyxl must use keep_vba=True. Work from the latest attached original, never rebuild from the extracted preview. For legacy Office and OpenDocument you can use a converted working copy and convert it back. For archives edit only the extracted workspace tree and repack all original members in the requested archive format. For media use installed FFmpeg; audio semantic understanding requires a provisioned offline Whisper model. After editing, validate the output and compare rendered PDF/image/Office layout previews with the original; inspect workbook formulas and styles. File utility preparation is an aid, not proof that an edit succeeded.`,
      'For DOCX edits, use Python standard-library zipfile and XML tools to edit WordprocessingML while preserving the rest of the package. For red text, set the Word run color to FF0000. Validate the resulting DOCX archive and verify the changed runs before finishing. Mention the generated filename in the final response.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}
