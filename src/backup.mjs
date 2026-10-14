import {DatabaseSync,backup}from'node:sqlite';
import{openSync,closeSync,fstatSync,statSync,realpathSync,chmodSync,unlinkSync,constants}from'node:fs';
import{resolve,dirname,basename,relative,isAbsolute,sep}from'node:path';
function within(root,path){const r=relative(root,path);return r===''||(r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r));}
export async function privateBackup(source,output,{publicDir,onProgress}={}){
 const parent=realpathSync(dirname(resolve(output))),target=resolve(parent,basename(output));
 if(publicDir&&within(realpathSync(publicDir),target))throw new Error('BACKUP_PUBLIC_DIRECTORY_FORBIDDEN');
 const directory=statSync(parent);
 // On Windows the operator must use an ACL-private directory; Unix mode/uid checks do not apply.
 if(process.platform!=='win32'&&((directory.mode&0o077)!==0||(process.getuid&&directory.uid!==process.getuid())))throw new Error('BACKUP_DIRECTORY_MUST_BE_PRIVATE_AND_OWNED');
 const fd=openSync(target,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW||0),0o600);
 const reserved=fstatSync(fd);closeSync(fd);
 let db;
 try{
  db=new DatabaseSync(source,{readOnly:true,allowExtension:false});
  await backup(db,target,{rate:100,...(onProgress?{progress:onProgress}:{})});
  const final=statSync(target);if(final.ino!==reserved.ino||final.dev!==reserved.dev)throw new Error('BACKUP_DESTINATION_CHANGED');
  if(process.platform!=='win32'&&(final.mode&0o077)!==0)throw new Error('BACKUP_PERMISSIONS_CHANGED');
  // Normalize only the newly reserved snapshot to a standalone file. A WAL-mode
  // snapshot's read-only verification can otherwise leave -wal/-shm sidecars.
  // The live source above remains read-only and keeps its original journal mode.
  const check=new DatabaseSync(target,{allowExtension:false});
  try{if(check.prepare('PRAGMA journal_mode=DELETE').get().journal_mode!=='delete'||check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||check.prepare('PRAGMA foreign_key_check').all().length)throw new Error('BACKUP_VERIFICATION_FAILED');}finally{check.close();}
  return target;
 }catch(e){try{const current=statSync(target);if(current.ino===reserved.ino&&current.dev===reserved.dev)unlinkSync(target);}catch{}throw e;}finally{db?.close();}
}
