import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDocxText, stageAttachments } from '../src/attachments.mjs';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function minimalDocx(documentXml) {
  const entries = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`],
    ['word/document.xml', documentXml],
  ];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [filename, contents] of entries) {
    const name = Buffer.from(filename, 'utf8');
    const raw = Buffer.from(contents, 'utf8');
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

test('extracts DOCX paragraphs, tabs and XML entities without a provider', () => {
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hola &amp; bon dia</w:t></w:r></w:p><w:p><w:r><w:t>Segon paràgraf</w:t><w:tab/><w:t>final</w:t></w:r></w:p></w:body></w:document>';
  assert.equal(extractDocxText(minimalDocx(xml)), 'Hola & bon dia\nSegon paràgraf\tfinal');
});

test('rejects malformed DOCX instead of sending compressed bytes as a prompt', () => {
  assert.throws(() => extractDocxText(Buffer.from('not a zip')), { code: 'invalid_docx' });
});

test('stages an attached DOCX and includes extracted text in provider prompt', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'bridge-docx-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Contenido adjunto</w:t></w:r></w:p></w:body></w:document>';
  const request = await stageAttachments({ prompt: 'Resume el archivo', attachments: [{
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filename: 'informe.docx', data: minimalDocx(xml).toString('base64'),
  }] }, cwd);
  assert.match(request.prompt, /Contenido adjunto/);
  assert.doesNotMatch(request.prompt, /word\/document\.xml/);
});
