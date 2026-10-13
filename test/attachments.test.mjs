import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDocxText, stageAttachments } from '../src/attachments.mjs';

function minimalDocx(documentXml) {
  const name = Buffer.from('word/document.xml');
  const data = deflateRawSync(Buffer.from(documentXml));
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(documentXml), 22);
  local.writeUInt16LE(name.length, 26); name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(Buffer.byteLength(documentXml), 24); central.writeUInt16LE(name.length, 28); name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, eocd]);
}

test('extracts DOCX paragraphs, tabs and XML entities without a provider', () => {
  const xml = '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Hola &amp; bon dia</w:t></w:r></w:p><w:p><w:r><w:t>Segon paràgraf</w:t><w:tab/><w:t>final</w:t></w:r></w:p></w:body></w:document>';
  assert.equal(extractDocxText(minimalDocx(xml)), 'Hola & bon dia\nSegon paràgraf\tfinal');
});

test('rejects malformed DOCX instead of sending compressed bytes as a prompt', () => {
  assert.throws(() => extractDocxText(Buffer.from('not a zip')), { code: 'invalid_docx' });
});

test('stages an attached DOCX and includes extracted text in provider prompt', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'bridge-docx-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const xml = '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Contenido adjunto</w:t></w:r></w:p></w:body></w:document>';
  const request = await stageAttachments({ prompt: 'Resume el archivo', attachments: [{
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filename: 'informe.docx', data: minimalDocx(xml).toString('base64'),
  }] }, cwd);
  assert.match(request.prompt, /Contenido adjunto/);
  assert.equal(request.attachments[0].extractedText, 'Contenido adjunto');
});
