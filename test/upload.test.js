/**
 * What actually gets uploaded to Cloudinary.
 *
 * The `mime_type` on an inbound WhatsApp message is set by the sender's
 * client, so a document announcing itself as image/png could carry anything.
 * The upload used to trust that claim and hand the bytes to Cloudinary with
 * resource_type 'auto', which will store more or less whatever it is given.
 *
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');

const { detectImageFormat, uploadBuffer } = require('../src/services/cloudinary');

// Minimal but genuine file signatures.
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(16)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'), Buffer.alloc(16)]);

test('the four formats WhatsApp can deliver are recognised', () => {
  assert.strictEqual(detectImageFormat(JPEG), 'jpeg');
  assert.strictEqual(detectImageFormat(PNG), 'png');
  assert.strictEqual(detectImageFormat(GIF), 'gif');
  assert.strictEqual(detectImageFormat(WEBP), 'webp');
});

test('non-images are rejected whatever they claim to be', () => {
  // A PDF, an ELF binary, a zip, HTML, and plain text — all things a client
  // could send while labelling the message image/png.
  assert.strictEqual(detectImageFormat(Buffer.from('%PDF-1.7\n%����\n')), null);
  assert.strictEqual(detectImageFormat(Buffer.from([0x7F, 0x45, 0x4C, 0x46, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.strictEqual(detectImageFormat(Buffer.from('PK\x03\x04apacked zip')), null);
  assert.strictEqual(detectImageFormat(Buffer.from('<!doctype html><html></html>')), null);
  assert.strictEqual(detectImageFormat(Buffer.from('just some text here ok')), null);
});

test('truncated and empty payloads are rejected, not crashed on', () => {
  assert.strictEqual(detectImageFormat(Buffer.alloc(0)), null);
  assert.strictEqual(detectImageFormat(Buffer.from([0xFF, 0xD8])), null, 'too short to be sure');
  assert.strictEqual(detectImageFormat(null), null);
  assert.strictEqual(detectImageFormat(undefined), null);
});

test('a RIFF container that is not WebP is rejected', () => {
  // RIFF also fronts .wav and .avi — the WEBP tag at offset 8 is what matters.
  const wav = Buffer.concat([
    Buffer.from('RIFF', 'latin1'), Buffer.from([0, 0, 0, 0]),
    Buffer.from('WAVE', 'latin1'), Buffer.alloc(16)]);
  assert.strictEqual(detectImageFormat(wav), null);
});

test('uploadBuffer refuses a non-image before spending a network call', async () => {
  await assert.rejects(
    () => uploadBuffer(Buffer.from('%PDF-1.7 not an image at all'), 'test/folder', 'x'),
    /not a JPEG, PNG, WebP or GIF/,
    'must reject with a message that says what was wrong',
  );
});

test('uploadBuffer still refuses an empty buffer', async () => {
  await assert.rejects(() => uploadBuffer(Buffer.alloc(0), 'test/folder', 'x'), /empty buffer/);
});
