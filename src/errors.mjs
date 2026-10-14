export function http(statusCode,code,message,fields) { const err = new Error(message); Object.assign(err,{statusCode,code,isPublic:true}); if(fields) err.fields=fields; return err; }
export const errors={http};
