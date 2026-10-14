import { spawnSync } from 'node:child_process';
console.log('Running DOM integration against the real app using jsdom. This is not a real-browser or visual-layout certification.');
const result=spawnSync(process.execPath,['--test','--test-concurrency=1','tests/qa-frontend.test.mjs'],{stdio:'inherit'});
process.exitCode=result.status??1;
