// Usage: <div class="quiz" data-quiz='[{"q":"..","a":["..",".."],"c":1,"why":".."}]'></div>
// When served by server/server.ts, answers are recorded; opened as a file, the quiz works without recording.
const lesson=location.pathname.split('/').pop();
const send=(path,body)=>{if(location.protocol==='file:')return;
  fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),keepalive:true}).catch(()=>{});};
send('/api/view',{lesson});
const shown=Date.now();
document.querySelectorAll('.quiz[data-quiz]').forEach(root=>{
  JSON.parse(root.dataset.quiz).forEach((item,i)=>{
    const d=document.createElement('div');d.className='q';
    d.innerHTML=`<p><strong>${i+1}.</strong> ${item.q}</p>`;
    const fb=document.createElement('p');fb.className='fb';
    let tries=0;
    item.a.forEach((txt,j)=>{const b=document.createElement('button');b.textContent=txt;
      b.onclick=()=>{d.querySelectorAll('button').forEach(x=>x.className='');
        b.className=j===item.c?'ok':'bad';fb.textContent=(j===item.c?'Correct. ':'Not quite. ')+item.why;
        send('/api/answer',{lesson,question:i,prompt:item.q,choice:txt,correct:j===item.c,firstTry:tries++===0,ms:Date.now()-shown});};
      d.appendChild(b)});
    d.appendChild(fb);root.appendChild(d)});
});
