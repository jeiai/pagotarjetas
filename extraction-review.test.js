const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { normalizeExtraction, extractStatementData } = require('./server');

const base = {
  minPayment:125.50,noInterestAmount:3560.75,totalAmount:4600.25,dueDate:'2026-09-25',
  evidence:{minPayment:'Pago mínimo $125.50',noInterestAmount:'Pago para no generar intereses $3,560.75',totalAmount:'Saldo total $4,600.25'},
};

test('minimum distinguishes visible values, explicit zero, missing and unrelated amounts',()=>{
  assert.equal(normalizeExtraction(base).minPayment,125.50);
  assert.equal(normalizeExtraction({...base,minPayment:null}).minPayment,null);
  assert.equal(normalizeExtraction({...base,minPayment:0,evidence:{...base.evidence,minPayment:''}}).minPayment,null);
  assert.equal(normalizeExtraction({...base,minPayment:0,evidence:{...base.evidence,minPayment:'Pago mínimo $0.00'}}).minPayment,0);
  assert.equal(normalizeExtraction({...base,evidence:{...base.evidence,minPayment:'Pago para no generar intereses $125.50'}}).minPayment,null);
  assert.equal(normalizeExtraction({...base,evidence:{...base.evidence,minPayment:'Pago mínimo + meses sin intereses $125.50'}}).minPayment,null);
  for(const amount of ['',false,-10,'abc','1,2,3',{},Infinity]) assert.equal(normalizeExtraction({...base,minPayment:amount}).minPayment,null);
  assert.ok(normalizeExtraction({...base,evidence:{}}).missingFields.includes('minPayment'));
  assert.equal(normalizeExtraction({...base,dueDate:'2026-02-30'}).dueDate,'');
  assert.equal(normalizeExtraction({...base,dueDate:'2028-02-29'}).dueDate,'2028-02-29');
});

test('vision request requires typed nullable amounts and evidence, without extra AI calls',async()=>{
  const previousFetch=global.fetch, previousKey=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='mock-only';
  let request, calls=0;
  try {
    global.fetch=async(_,options)=> { calls++; request=JSON.parse(options.body); return new Response(JSON.stringify({output_text:JSON.stringify(base)})); };
    const result=await extractStatementData({filename:'test.png',contentType:'image/png',buffer:Buffer.from('test')});
    assert.equal(result.minPayment,125.5);
    assert.equal(calls,1);
    assert.equal(request.text.format.type,'json_schema');
    assert.equal(request.text.format.strict,true);
    assert.deepEqual(request.text.format.schema.properties.minPayment.type,['number','null']);
    assert.ok(request.text.format.schema.required.includes('evidence'));
    assert.equal(request.input[0].content[1].detail,'high');
  } finally {
    global.fetch=previousFetch;
    if(previousKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previousKey;
  }
});

test('dashboard excludes unreviewed extraction, displays missing minimum and includes corrected amounts',()=>{
  const nodes=new Map();
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{style:{},classList:{add(){},remove(){}},addEventListener(){},value:'todos'});return nodes.get(selector);};
  const context=vm.createContext({document:{querySelector:node,querySelectorAll:()=>[]},Intl,FormData,console});
  vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/loadApp\(\);\s*$/,''),context);
  vm.runInContext(`state.user={id:'test',name:'Test'};state.cards=[{id:'c',bankName:'Banco',cardName:'Oro'}];
    state.statements=[{id:'s',cardId:'c',extractedAt:'2026-09-11',needsReview:true,minPayment:null,noInterestAmount:200,totalAmount:500,status:'pendiente',dueDate:'2026-09-25',period:'Septiembre',file:{id:'f'}}];render();`,context);
  assert.match(node('#summaryMinimum').textContent,/0\.00/);
  assert.match(node('#summaryNoInterest').textContent,/0\.00/);
  assert.match(node('#summaryReview').textContent,/1 archivo/);
  assert.match(node('#recordsList').innerHTML,/No identificado/);
  assert.match(node('#recordsList').innerHTML,/Confirmar importes/);
  vm.runInContext(`state.statements[0].minPayment=100;state.statements[0].needsReview=false;state.statements[0].reviewedAt='2026-09-11';render();`,context);
  assert.match(node('#summaryMinimum').textContent,/100\.00/);
  assert.match(node('#summaryNoInterest').textContent,/200\.00/);
  vm.runInContext(`delete state.statements[0].reviewedAt;state.statements[0].minPayment=0;render();`,context);
  assert.match(node('#summaryReview').textContent,/1 archivo/);
  assert.match(node('#recordsList').innerHTML,/Lectura anterior/);
});
