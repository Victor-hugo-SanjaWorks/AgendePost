import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { http } from '../src/errors.mjs';
import { normalizeRaster, safeFilename, MAX_IMAGE_BYTES } from '../src/media/normalize.mjs';
import { validateSchedule } from '../src/editorial/shared.mjs';
import { harness, verified, route, idempotency, multipart, assertDenied } from './qa-helpers.mjs';
const ctx={errors:{http},now:()=> '2026-10-14T00:00:00.000Z'};
const digest=b=>createHash('sha256').update(b).digest('hex');

test('security: raster normalization strips EXIF and polyglot bytes; SVG, MIME lies, animation and image bombs are rejected',async()=>{
  const image=sharp({create:{width:20,height:10,channels:3,background:'#5599bb'}});
  const jpeg=await image.clone().withMetadata({exif:{IFD0:{Artist:'QA PRIVATE EXIF MARKER'}}}).jpeg().toBuffer();
  assert.ok((await sharp(jpeg).metadata()).exif);
  const normalized=await normalizeRaster(jpeg,'image/jpeg',ctx), metadata=await sharp(normalized.bytes).metadata();
  assert.equal(metadata.exif,undefined);assert.equal(metadata.icc,undefined);assert.equal(metadata.xmp,undefined);
  assert.equal(normalized.sizeBytes,normalized.bytes.length);assert.equal(normalized.digest,digest(normalized.bytes));
  assert.equal(normalized.width,20);assert.equal(normalized.height,10);
  for(const format of ['png','webp']) {
    const input=await image.clone()[format]().toBuffer(), output=await normalizeRaster(input,`image/${format}`,ctx);
    assert.equal((await sharp(output.bytes).metadata()).format,format);
  }
  const png=await image.clone().png().toBuffer();
  const polyglot=await normalizeRaster(Buffer.concat([png,Buffer.from('<script>QA_POLYGLOT()</script>')]),'image/png',ctx);
  assert.ok(!polyglot.bytes.includes(Buffer.from('QA_POLYGLOT')));
  for(const [bytes,mime]of [[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),'image/svg+xml'],[Buffer.from('<html>not pixels</html>'),'image/png'],[png,'image/jpeg'],[png.subarray(0,40),'image/png']])
    await assert.rejects(normalizeRaster(bytes,mime,ctx),e=>e.statusCode===422);
  const acTL=Buffer.alloc(20);acTL.writeUInt32BE(8,0);acTL.write('acTL',4);acTL.writeUInt32BE(2,8);
  await assert.rejects(normalizeRaster(Buffer.concat([png.subarray(0,33),acTL,png.subarray(33)]),'image/png',ctx),e=>e.code==='ANIMATED_IMAGE_UNSUPPORTED');
  const animatedWebp=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBPANIM'),Buffer.alloc(8)]);
  await assert.rejects(normalizeRaster(animatedWebp,'image/webp',ctx),e=>e.code==='ANIMATED_IMAGE_UNSUPPORTED');
  const tooWide=await sharp({create:{width:10001,height:1,channels:3,background:'#000000'}}).png().toBuffer();
  await assert.rejects(normalizeRaster(tooWide,'image/png',ctx),e=>e.statusCode===422);
  const tooManyPixels=await sharp({create:{width:5001,height:5000,channels:3,background:'#000000'}}).png().toBuffer();
  await assert.rejects(normalizeRaster(tooManyPixels,'image/png',ctx),e=>e.statusCode===422);
  await assert.rejects(normalizeRaster(Buffer.alloc(MAX_IMAGE_BYTES+1),'image/png',ctx),e=>e.statusCode===413);
  assert.equal(safeFilename('../../etc/passwd'),'passwd');assert.equal(safeFilename('..\\..\\evil.png'),'evil.png');
});

test('QA timezones: explicit offset, impossible days, DST gaps and both ambiguous choices are checked',()=>{
  assert.deepEqual(validateSchedule(ctx,'2026-12-01T00:30:00-03:00','America/Sao_Paulo'),{scheduledAt:'2026-12-01T03:30:00.000Z',scheduledTimezone:'America/Sao_Paulo'});
  for(const [date,zone]of [['2026-12-01T00:30:00','America/Sao_Paulo'],['2026-02-30T12:00:00Z','UTC'],['2026-03-08T02:30:00-05:00','America/New_York'],['2026-03-08T02:30:00-04:00','America/New_York'],['2026-12-01T00:30:00+01:00','America/Sao_Paulo']]) assert.throws(()=>validateSchedule(ctx,date,zone),e=>e.statusCode===422);
  assert.equal(validateSchedule(ctx,'2026-11-01T01:30:00-04:00','America/New_York').scheduledAt,'2026-11-01T05:30:00.000Z');
  assert.equal(validateSchedule(ctx,'2026-11-01T01:30:00-05:00','America/New_York').scheduledAt,'2026-11-01T06:30:00.000Z');
});

test('security: upload limits and failures leave no orphan rows; normalized-byte quota is atomic',async t=>{
  const h=await harness(t),owner=await verified(h,'media-owner');
  const tenant=await owner.client.ok('POST','/api/v1/tenants',{name:'Media QA',slug:'media-qa',timezone:'UTC'},idempotency());
  const workspace=await owner.client.ok('POST',`/api/v1/tenants/${tenant.id}/workspaces`,{name:'Private images'},idempotency());
  const path=route(tenant,workspace,'/media');
  for(const fixture of [multipart(Buffer.from('<svg></svg>'),{mime:'image/svg+xml',filename:'bad.svg'}),multipart(Buffer.alloc(MAX_IMAGE_BYTES+1),{mime:'image/png',filename:'too-large.png'})]) {
    const result=await owner.client.request('POST',path,fixture.payload,{headers:{...fixture.headers,'idempotency-key':'invalid-upload-'+fixture.payload.length}});
    assert.ok([413,422].includes(result.status),result.body);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM media').get().n,0);assert.equal(h.db.prepare('SELECT count(*) AS n FROM media_blobs').get().n,0);
  }
  const bytes=await sharp({create:{width:24,height:24,channels:3,background:'#441188'}}).png().toBuffer();
  const normalized=await normalizeRaster(bytes,'image/png',ctx);
  h.db.prepare('INSERT INTO plans(id,version,label,limits_json,flags_json,active) VALUES(?,?,?,?,?,1)').run('qa_exact_media',1,'QA exact bytes',JSON.stringify({workspaces:2,members:3,posts:100,mediaBytes:normalized.sizeBytes}),JSON.stringify({editorialPlanning:true,socialPublishing:false}));
  h.db.prepare("UPDATE tenant_entitlements SET plan_id='qa_exact_media',plan_version=1,version=version+1 WHERE tenant_id=?").run(tenant.id);
  const pair=await Promise.all(['first','second'].map(name=>{const form=multipart(bytes,{filename:`${name}.png`});return owner.client.request('POST',path,form.payload,{headers:{...form.headers,'idempotency-key':name+'-media-key'}});}));
  assert.equal(pair.filter(r=>r.status===201).length,1,JSON.stringify(pair.map(r=>r.json)));assert.equal(pair.filter(r=>r.status===409).length,1);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM media').get().n,1);assert.equal(h.db.prepare('SELECT count(*) AS n FROM media_blobs').get().n,1);
  const media=pair.find(r=>r.status===201).data;
  assert.equal(media.sizeBytes,normalized.sizeBytes);
  const download=await owner.client.request('GET',path+`/${media.id}/content`);
  assert.equal(download.status,200);assert.equal(download.headers['cache-control'],'private, no-store');assert.equal(download.headers['x-content-type-options'],'nosniff');assert.equal(download.headers['content-type'],'image/png');
  assert.equal(digest(download.raw),normalized.digest);
  await owner.client.ok('DELETE',path+`/${media.id}`);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM media_blobs').get().n,0);
});
