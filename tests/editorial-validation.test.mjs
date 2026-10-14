import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { errors } from '../src/errors.mjs';
import { validateSchedule } from '../src/editorial/shared.mjs';
import { normalizeRaster, safeFilename, MAX_IMAGE_BYTES } from '../src/media/normalize.mjs';
const ctx = { errors, now: () => '2026-10-14T00:00:00.000Z' };

test('editorial dates: São Paulo, UTC, year boundary and explicit DST offsets preserve intention', () => {
  assert.deepEqual(validateSchedule(ctx, '2026-12-31T23:30:00-03:00', 'America/Sao_Paulo'), { scheduledAt: '2027-01-01T02:30:00.000Z', scheduledTimezone: 'America/Sao_Paulo' });
  assert.equal(validateSchedule(ctx, '2026-11-01T01:30:00-04:00', 'America/New_York').scheduledAt, '2026-11-01T05:30:00.000Z');
  assert.equal(validateSchedule(ctx, '2026-11-01T01:30:00-05:00', 'America/New_York').scheduledAt, '2026-11-01T06:30:00.000Z');
  assert.equal(validateSchedule(ctx, '2026-10-15T12:00:00Z', 'UTC', { future: true }).scheduledAt, '2026-10-15T12:00:00.000Z');
});

test('editorial dates reject impossible, offsetless, DST-gap, incoherent and past planning times', () => {
  for (const [value, zone] of [
    ['2026-02-30T12:00:00Z','UTC'], ['2026-10-15T24:00:00Z','UTC'],
    ['2026-10-15T10:00:00','America/Sao_Paulo'], ['2026-03-08T02:30:00-05:00','America/New_York'],
    ['2026-11-01T01:30:00-06:00','America/New_York'], ['2026-10-15T10:00:00Z','America/Sao_Paulo'],
    ['2026-10-15T10:00:00-03:00','MadeUp/Zone'], ['2026-10-15T10:00:00+99:99','UTC']
  ]) assert.throws(() => validateSchedule(ctx, value, zone), e => e.statusCode === 422, `${value} ${zone}`);
  assert.throws(() => validateSchedule(ctx, '2026-10-13T10:00:00Z', 'UTC', { future: true }), e => e.code === 'SCHEDULE_IN_PAST');
});

test('raster normalization really decodes, re-encodes and strips EXIF plus appended content', async () => {
  for (const format of ['png','jpeg','webp']) {
    const mime = `image/${format}`;
    let input = await sharp({ create: { width: 31, height: 17, channels: 3, background: '#9876ab' } })[format]().withExif({ IFD0: { Copyright: 'PRIVATE GPS-LIKE METADATA' } }).toBuffer();
    input = Buffer.concat([input, Buffer.from('<script>privateTrailingPayload</script>')]);
    const result = await normalizeRaster(input, mime, ctx);
    assert.equal(result.width, 31); assert.equal(result.height, 17); assert.equal(result.mime, mime);
    assert.equal(result.sizeBytes, result.bytes.length); assert.equal(result.digest.length, 64);
    assert.notDeepEqual(result.bytes, input);
    assert.ok(!result.bytes.includes(Buffer.from('privateTrailingPayload')));
    const meta = await sharp(result.bytes).metadata();
    assert.equal(meta.exif, undefined); assert.equal(meta.xmp, undefined); assert.equal(meta.icc, undefined);
    assert.equal(meta.format, format);
  }
});

test('raster boundary rejects HTML, SVG, MIME spoof, truncation, animation, dimensions and oversized bytes', async () => {
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#000000' } }).png().toBuffer();
  const wide = await sharp({ create: { width: 10001, height: 1, channels: 3, background: '#000000' } }).png().toBuffer();
  const apngChunk = Buffer.concat([Buffer.from([0,0,0,8]), Buffer.from('acTL'), Buffer.from([0,0,0,2,0,0,0,0,0,0,0,0])]);
  const apng = Buffer.concat([png.subarray(0,33), apngChunk, png.subarray(33)]);
  for (const [data, mime, expected] of [
    [Buffer.from('<html>anything</html>'), 'image/png', 422],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml', 422],
    [png, 'image/jpeg', 422], [png.subarray(0,30), 'image/png', 422],
    [apng, 'image/png', 422], [wide, 'image/png', 422], [Buffer.alloc(MAX_IMAGE_BYTES+1), 'image/png', 413]
  ]) await assert.rejects(() => normalizeRaster(data,mime,ctx), error => error.statusCode === expected);
  assert.equal(safeFilename('../../escape\\image\0.png'), 'image.png');
});
