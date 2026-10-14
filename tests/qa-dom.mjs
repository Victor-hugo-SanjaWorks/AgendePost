import assert from 'node:assert/strict';
import { JSDOM, CookieJar, requestInterceptor, VirtualConsole } from 'jsdom';
let browserAddress=40;

export async function domPage(h,t,{hash='/login',jar=new CookieJar(),beforeFetch}={}) {
  const origin=h.app.ctx.config.canonicalOrigin,errors=[],requests=[],clientAddress=`127.2.0.${browserAddress++}`,address=h.app.ctx.config.hosted?'127.0.0.1':clientAddress;
  const proxyHeaders=h.app.ctx.config.hosted?{'x-forwarded-for':clientAddress,'x-forwarded-proto':'https'}:{};
  const resources={interceptors:[requestInterceptor(async request=>{
    const url=new URL(request.url);assert.equal(url.origin,origin,'Frontend must not load third-party resources');
    const response=await h.app.inject({url:url.pathname+url.search,headers:{host:url.host,...proxyHeaders},remoteAddress:address});
    assert.equal(response.statusCode,200,`${url}: ${response.body}`);
    return new Response(response.rawPayload,{status:response.statusCode,headers:response.headers});
  })]};
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',e=>errors.push(e));
  const html=await h.app.inject({url:'/app',headers:{host:new URL(origin).host,...proxyHeaders},remoteAddress:address});
  const dom=new JSDOM(html.body,{url:origin+'/app#'+hash,runScripts:'dangerously',resources,cookieJar:jar,pretendToBeVisual:true,virtualConsole,
    beforeParse(window){
      window.scrollTo=()=>{};window.confirm=()=>true;
      window.fetch=async(path,options={})=>{
        const url=new URL(path,window.location.href);assert.equal(url.origin,origin,'Frontend API calls must stay same-origin');
        const method=(options.method??'GET').toUpperCase(),headers={host:url.host,...proxyHeaders,...options.headers};
        headers.cookie=await jar.getCookieString(url.href);
        if(!['GET','HEAD'].includes(method))headers.origin=origin;
        let payload=options.body;
        if(payload instanceof window.FormData){
          const form=new FormData();
          for(const [name,value] of payload.entries()){
            if(typeof value==='string')form.append(name,value);
            else {const array=await new Promise((resolve,reject)=>{const reader=new window.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsArrayBuffer(value);});form.append(name,new Blob([array],{type:value.type}),value.name);}
          }
          const request=new Request(url,{method,body:form});payload=Buffer.from(await request.arrayBuffer());headers['content-type']=request.headers.get('content-type');
        }
        if(beforeFetch)await beforeFetch({path:url.pathname+url.search,method,headers,payload});
        const response=await h.app.inject({method,url:url.pathname+url.search,headers,remoteAddress:address,...(payload===undefined?{}:{payload})});
        const setCookie=response.headers['set-cookie'];for(const cookie of Array.isArray(setCookie)?setCookie:setCookie?[setCookie]:[])await jar.setCookie(cookie,url.href);
        requests.push({path:url.pathname+url.search,method,status:response.statusCode});
        const publicHeaders={...response.headers};delete publicHeaders['set-cookie'];
        return new Response(method==='HEAD'||response.statusCode===204?null:response.rawPayload,{status:response.statusCode,headers:publicHeaders});
      };
    }});
  t?.after(()=>dom.window.close());
  const page={dom,window:dom.window,document:dom.window.document,jar,errors,requests};
  page.$=selector=>page.document.querySelector(selector);
  page.text=()=>page.document.body.textContent;
  page.wait=async(predicate,label='DOM condition',timeout=6000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=predicate();if(value)return value;if(errors.length)throw errors[0];await new Promise(r=>setTimeout(r,15));}throw new Error(`Timed out waiting for ${label}. Requests: ${JSON.stringify(requests.slice(-8))}. DOM: ${page.text().slice(-1500)}`);};
  page.fill=(selector,value)=>{const element=page.$(selector);assert.ok(element,selector);element.value=value;element.dispatchEvent(new page.window.Event('input',{bubbles:true}));};
  page.change=(selector,value)=>{const element=page.$(selector);assert.ok(element,selector);element.value=value;element.dispatchEvent(new page.window.Event('change',{bubbles:true}));};
  page.click=selector=>{const element=page.$(selector);assert.ok(element,selector);element.click();};
  page.submit=selector=>{const form=page.$(selector);assert.ok(form,selector);form.dispatchEvent(new page.window.Event('submit',{bubbles:true,cancelable:true}));};
  page.navigate=async(hash,selector)=>{page.window.location.hash=hash;await page.wait(()=>page.$(selector),selector);};
  page.login=async(identity)=>{await page.wait(()=>page.$('#login-form'),'login form');page.fill('#login-email',identity.email);page.fill('#login-password',identity.password);page.submit('#login-form');await page.wait(()=>page.$('#tenant-select')||page.$('#tenant-form'),'authenticated app',15000);};
  return page;
}
