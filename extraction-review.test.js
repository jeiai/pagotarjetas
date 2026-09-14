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

test('payment tiles accept a standalone minimum label without accepting unrelated minimums',()=>{
  for (const label of ['Mínimo $125.50', '$125.50\nMínimo', 'Mínimo: MXN $125.50', 'Pago de tarjeta — $125.50 Mínimo', 'Pago de la tarjeta: Mínimo $125.50']) {
    assert.equal(normalizeExtraction({...base,evidence:{...base.evidence,minPayment:label}}).minPayment,125.50,label);
  }
  for (const label of ['Depósito mínimo $125.50', 'Retiro mínimo $125.50', 'Crédito mínimo $125.50', 'Mínimo + mensualidad $125.50', 'Pago mínimo y cuotas $125.50', 'Pago mensual completo $125.50', 'Disponible en Crédito -$125.50']) {
    assert.equal(normalizeExtraction({...base,evidence:{...base.evidence,minPayment:label}}).minPayment,null,label);
  }
  assert.equal(normalizeExtraction({...base,minPayment:0,evidence:{...base.evidence,minPayment:'$0.00 Mínimo'}}).minPayment,0);
});

test('transcribed payment screen examples preserve distinct amounts and absent minimums',()=>{
  // Synthetic values for five layouts; no customer screenshots or amounts are fixtures.
  const examples = [
    {minPayment:125.50,noInterestAmount:3560.75,totalAmount:4600.25,evidence:base.evidence},
    {minPayment:210.25,noInterestAmount:null,totalAmount:1800.50,evidence:{minPayment:'Pago mínimo $210.25',noInterestAmount:'',totalAmount:'Saldo total $1,800.50'},notes:'Pago total $1,700.00; monto vencido $1,700.00.'},
    {minPayment:null,noInterestAmount:null,totalAmount:2400.25,evidence:{minPayment:'',noInterestAmount:'',totalAmount:'Saldo actual $2,400.25'},dueDate:null,notes:'Fecha de corte 18 SEP; pago mínimo no visible.'},
    {minPayment:null,noInterestAmount:null,totalAmount:3600.75,evidence:{minPayment:'',noInterestAmount:'',totalAmount:'Deuda total $3,600.75'},dueDate:null,notes:'Más opciones de pago después del corte.'},
    {minPayment:80,noInterestAmount:null,totalAmount:950.25,evidence:{minPayment:'$80 Mínimo',noInterestAmount:'',totalAmount:'Saldo total $950.25'},dueDate:null,lastFour:'',notes:'Pago mensual completo $900.00; paga en 4 días; varias miniaturas de tarjetas.'},
  ];
  for (const example of examples) {
    const result=normalizeExtraction(example);
    for (const field of ['minPayment','noInterestAmount','totalAmount']) assert.equal(result[field],example[field]);
    if (example.dueDate===null) assert.equal(result.dueDate,'');
    if (example.notes) assert.equal(result.notes,example.notes);
  }
  assert.equal(normalizeExtraction(examples[4]).lastFour,'');
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
  assert.match(node('#cardsList').innerHTML,/Septiembre/);
  assert.match(node('#cardsList').innerHTML,/2026-09-25/);
  assert.match(node('#cardsList').innerHTML,/Estado/);
  assert.match(node('#cardsList').innerHTML,/Pendiente/);
  assert.match(node('#cardsList').innerHTML,/No identificado/);
  assert.match(node('#recordsList').innerHTML,/No identificado/);
  assert.match(node('#recordsList').innerHTML,/Confirmar importes/);
  assert.match(node('#recordsList').innerHTML,/Selecciona el mes/);
  assert.equal(vm.runInContext(`buildPeriod('BBVA','Septiembre','2026')`,context),'BBVA Septiembre 2026');
  assert.ok(node('#cardSelect').innerHTML.indexOf('banamex') < node('#cardSelect').innerHTML.indexOf('bancoppel'));
  assert.ok(node('#cardSelect').innerHTML.indexOf('bancoppel') < node('#cardSelect').innerHTML.indexOf('banorte'));
  assert.match(node('#cardSelect').innerHTML,/falabella/);
  assert.match(node('#cardSelect').innerHTML,/otro/);
  assert.ok(node('#cardSelect').innerHTML.indexOf('plata') < node('#cardSelect').innerHTML.indexOf('stori'));
  vm.runInContext(`state.cards.push({id:'custom',bankName:'Amex',cardName:'Tarjeta',periodOptionName:'Amex'});render();`,context);
  assert.match(node('#cardSelect').innerHTML,/Amex/);
  vm.runInContext(`state.statements[0].minPayment=100;state.statements[0].needsReview=false;state.statements[0].reviewedAt='2026-09-11';render();`,context);
  assert.match(node('#summaryMinimum').textContent,/100\.00/);
  assert.match(node('#summaryNoInterest').textContent,/200\.00/);
  assert.match(node('#cardsList').innerHTML,/100\.00/);
  vm.runInContext(`state.statements[0].status='parcial';state.statements[0].partialPaymentAmount=40.25;render();`,context);
  assert.match(node('#cardsList').innerHTML,/Parcial/);
  assert.match(node('#cardsList').innerHTML,/Monto abonado/);
  assert.match(node('#cardsList').innerHTML,/40\.25/);
  for (const [status,label] of [['programado','Programado'],['pagado','Pagado']]) {
    vm.runInContext(`state.statements[0].status='${status}';render();`,context);
    assert.match(node('#cardsList').innerHTML,new RegExp(label));
  }
  vm.runInContext(`state.statements[0].status='pendiente';delete state.statements[0].reviewedAt;state.statements[0].minPayment=0;render();`,context);
  assert.match(node('#summaryReview').textContent,/1 archivo/);
  assert.match(node('#recordsList').innerHTML,/Lectura anterior/);
  vm.runInContext(`state.statements[0].minPayment=100;state.statements.push({id:'s2',cardId:'c',minPayment:50,noInterestAmount:80,totalAmount:100,status:'pendiente',dueDate:'2026-10-25',period:'Octubre',file:{id:'f2'}});render();`,context);
  const cardsHtml = node('#cardsList').innerHTML;
  assert.ok(cardsHtml.indexOf('Octubre') < cardsHtml.indexOf('Septiembre'));
  assert.equal(node('#summaryCards').textContent,3);
});
