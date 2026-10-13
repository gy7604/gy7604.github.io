// Shared bounded transport. Never retry writes automatically.
async function appFetch(input,options={}) {
  const url=typeof input==='string'?input:input.url;
  const controller=new AbortController();
  const abort=()=>controller.abort(options.signal?.reason);
  if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(new DOMException('통신 응답 시간이 초과되었습니다.','TimeoutError')),url.includes('/get-holidays')?5000:15000);
  try{return await fetch(input,{...options,signal:controller.signal});}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}
