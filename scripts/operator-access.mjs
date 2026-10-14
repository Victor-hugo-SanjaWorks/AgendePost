import { buildConfig } from '../src/config.mjs';
import { issueOperatorAccess } from '../src/operator-access.mjs';
const args=process.argv.slice(2),allowed=new Set(['--purpose','--email','--name','--invitation-id','--confirm-verified-recipient']);
const values={};let valid=true;
for(let i=0;i<args.length;i++){
 const key=args[i];if(!allowed.has(key)||Object.hasOwn(values,key)){valid=false;break;}
 if(key==='--confirm-verified-recipient'){values[key]=true;continue;}
 if(!args[i+1]||args[i+1].startsWith('--')){valid=false;break;}values[key]=args[++i];
}
if(!valid||!values['--confirm-verified-recipient']||!values['--email']||!values['--purpose']){
 console.error('Usage: npm run operator:access -- --purpose enroll|reset|invitation --email VERIFIED_EMAIL [--name DISPLAY_NAME] [--invitation-id ID] --confirm-verified-recipient\nVerify the exact recipient through a trusted channel first. Output is a private one-use bearer link, not an email. Do not record the terminal or paste it in a shared conversation.');process.exit(1);
}
try{
 const result=issueOperatorAccess(buildConfig(),{purpose:values['--purpose'],email:values['--email'],displayName:values['--name'],invitationId:values['--invitation-id']});
 console.log(`Private one-use ${result.purpose} link for ${result.email}\nExpires: ${result.expiresAt}\n${result.url}\nNo external email was sent. Deliver only to the independently verified recipient; they choose their own password.`);
}catch(error){console.error(/^[A-Z_]+$/.test(error.message)?error.message:'OPERATOR_ACCESS_FAILED');process.exitCode=1;}
