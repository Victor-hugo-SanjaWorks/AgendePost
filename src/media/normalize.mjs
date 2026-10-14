import sharp from 'sharp';
import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PIXELS = 25_000_000;
export const MAX_DIMENSION = 10_000;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function safeFilename(filename) {
  return String(filename || 'imagem').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'imagem';
}
function actualFormat(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
function isAnimatedContainer(buffer, format) {
  // APNG is not exposed as multiple pages by every libvips build. Inspect real PNG chunks too.
  if (format === 'png') {
    let offset = 8;
    while (offset + 12 <= buffer.length) {
      const size = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
      if (size > buffer.length - offset - 12) return false; // Decoder rejects malformed chunks.
      if (type === 'acTL') return true;
      offset += size + 12;
      if (type === 'IEND') break;
    }
  }
  if (format === 'webp') {
    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const type = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4);
      if (type === 'ANIM' || type === 'ANMF') return true;
      if (size > buffer.length - offset - 8) return false;
      offset += 8 + size + (size % 2);
    }
  }
  return false;
}
export async function normalizeRaster(bytes, mime, ctx) {
  const reject = (code = 'INVALID_IMAGE', message = 'Envie uma imagem JPEG, PNG ou WebP estática válida.') => { throw ctx.errors.http(422, code, message); };
  if (!Buffer.isBuffer(bytes) || !bytes.length) reject();
  if (bytes.length > MAX_IMAGE_BYTES) throw ctx.errors.http(413, 'IMAGE_TOO_LARGE', 'A imagem excede 5 MiB.');
  const format = actualFormat(bytes);
  const expectedMime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[format];
  if (!expectedMime || mime !== expectedMime) reject('IMAGE_TYPE_MISMATCH', 'O tipo informado precisa corresponder a JPEG, PNG ou WebP real.');
  if (isAnimatedContainer(bytes, format)) reject('ANIMATED_IMAGE_UNSUPPORTED', 'Imagens animadas não são aceitas neste piloto.');
  let output;
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_PIXELS, sequentialRead: true });
    const metadata = await image.metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height || metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION || metadata.width * metadata.height > MAX_PIXELS) reject('IMAGE_DIMENSIONS', 'A imagem deve ter no máximo 25 megapixels e 10.000 pixels por dimensão.');
    if ((metadata.pages || 1) !== 1 || metadata.pageHeight && metadata.pageHeight !== metadata.height) reject('ANIMATED_IMAGE_UNSUPPORTED', 'Imagens animadas não são aceitas neste piloto.');
    // Re-encoding and default metadata stripping neutralize trailing HTML/polyglots and EXIF/GPS.
    const pipeline = image.rotate().toColourspace('srgb');
    if (format === 'jpeg') pipeline.jpeg({ quality: 90, mozjpeg: false });
    else if (format === 'png') pipeline.png({ compressionLevel: 6 });
    else pipeline.webp({ quality: 90, effort: 3 });
    output = await pipeline.toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error.statusCode) throw error;
    reject();
  }
  if (output.data.length > MAX_IMAGE_BYTES) throw ctx.errors.http(413, 'NORMALIZED_IMAGE_TOO_LARGE', 'A imagem normalizada excede 5 MiB.');
  if (output.info.width > MAX_DIMENSION || output.info.height > MAX_DIMENSION || output.info.width * output.info.height > MAX_PIXELS) reject('IMAGE_DIMENSIONS');
  return { bytes: output.data, mime: expectedMime, width: output.info.width, height: output.info.height, sizeBytes: output.data.length, digest: digest(output.data) };
}
