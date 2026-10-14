import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';

const $ = id => document.getElementById(id);
const clamp = (n,a,b) => Math.min(b,Math.max(a,n));
const rad = THREE.MathUtils.degToRad;
const clone = x => JSON.parse(JSON.stringify(x));
const specs = [
  {model:'RC 100B',name:'主灯',watts:100,lux:20100,min:2700,max:6500,color:'#b08b45',purpose:'决定脸部主要的明暗'},
  {model:'RC 60B',name:'辅灯',watts:63,lux:11200,min:2700,max:6500,color:'#76a99c',purpose:'让暗部轻一点，保留细节'},
  {model:'RC 60C',name:'轮廓灯',watts:63,lux:2350,min:2500,max:10000,color:'#a49ac7',purpose:'勾出人物边缘，与背景分开'}
];
const baseLights = [
  {on:true,power:65,temp:5600,angle:-35,distance:1.5,height:2,modifier:'soft',mode:'cct',hue:200,saturation:75},
  {on:true,power:42,temp:5600,angle:40,distance:1.8,height:1.65,modifier:'soft',mode:'cct',hue:200,saturation:75},
  {on:true,power:75,temp:5600,angle:135,distance:1.2,height:1.85,modifier:'bare',mode:'cct',hue:200,saturation:75}
];
const presets = {
  natural:{caption:'柔和，且有层次。',sub:'NATURAL LIGHT / 01',lights:clone(baseLights)},
  single:{caption:'一盏灯，也有表情。',sub:'ONE LIGHT / 02',lights:baseLights.map((l,i)=>({...l,on:i===0,angle:i===0?-45:l.angle}))},
  contrast:{caption:'让阴影说一点话。',sub:'LIGHT & SHADOW / 03',lights:baseLights.map((l,i)=>({...l,power:i===1?12:l.power,angle:i===0?-65:l.angle,modifier:i===0?'standard':l.modifier}))},
  color:{caption:'在边缘，留一点色彩。',sub:'A TOUCH OF COLOR / 04',lights:baseLights.map((l,i)=>({...l,power:i===2?100:l.power,mode:i===2?'rgb':'cct',angle:i===2?115:l.angle,distance:i===2?.85:l.distance,hue:205,saturation:90}))}
};
const modelProfiles={
  matte:{name:'原版哑光',tag:'原版哑光 · 观察明暗与阴影',hint:'忽略肤色干扰，专心看鼻影和脸部明暗。'},
  portrait:{name:'写实女模',tag:'写实女模 · 肤色、睁眼与头发',hint:'观察眼部反光、肤色冷暖和头发边缘；切换模特不改变灯位。'}
};
let state={lights:clone(baseLights),selected:0,exposure:0,bg:'warm',preset:'natural',yaw:0,pitch:0,model:'matte'};
try {
  const saved=JSON.parse(localStorage.getItem('light-study-v1'));
  if(saved && Array.isArray(saved.lights) && saved.lights.length===3) {
    state.lights=saved.lights.map((l,i)=>({
      ...baseLights[i],on:typeof l.on==='boolean'?l.on:true,
      power:clamp(Number(l.power)||0,0,100),temp:clamp(Number(l.temp)||5600,specs[i].min,specs[i].max),
      angle:clamp(Number(l.angle)||0,-180,180),distance:clamp(Number(l.distance)||1.5,.6,3),height:clamp(Number(l.height)||1.8,.8,2.8),
      modifier:(i===2?['soft','bare']:['soft','standard']).includes(l.modifier)?l.modifier:baseLights[i].modifier,
      mode:i===2&&l.mode==='rgb'?'rgb':'cct',hue:clamp(Number(l.hue)||0,0,360),saturation:clamp(Number(l.saturation)||0,0,100)
    }));
    state.selected=clamp(Math.round(Number(saved.selected)||0),0,2);
    state.exposure=clamp(Number(saved.exposure)||0,-2,2);
    state.bg=['warm','light','dark'].includes(saved.bg)?saved.bg:'warm';
    state.preset=Object.hasOwn(presets,saved.preset)?saved.preset:'natural';
    state.model=Object.hasOwn(modelProfiles,saved.model)?saved.model:'matte';
  }
} catch {}
let toastTimer,capture=null,comparing=false,lesson=0,renderer,scene,camera,subject,ready=false;
const modelCache=new Map();
let modelLoading=false;
const rigs=[];
const faceCenter=new THREE.Vector3(0,1.49,.04);

function persist(){try{localStorage.setItem('light-study-v1',JSON.stringify(state));}catch{}}
function toast(text){$('toast').textContent=text;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),2700)}
function lampPosition(l){return new THREE.Vector3(Math.sin(rad(l.angle))*l.distance,l.height,Math.cos(rad(l.angle))*l.distance)}
function modifierFactor(l){return l.modifier==='soft'?.35:1}
function luxEstimate(l,i){return l.on?specs[i].lux*(l.power/100)*modifierFactor(l)/lampPosition(l).distanceToSquared(faceCenter):0}
function kelvinRGB(k){
  const t=k/100;
  let r=t<=66?255:329.698727446*Math.pow(t-60,-.1332047592);
  let g=t<=66?99.4708025861*Math.log(t)-161.1195681661:288.1221695283*Math.pow(t-60,-.0755148492);
  let b=t>=66?255:t<=19?0:138.5177312231*Math.log(t-10)-305.0447927307;
  return [r,g,b].map(v=>clamp(v,0,255)/255);
}
const referenceWhite=kelvinRGB(5600);
function lightColor(l){
  if(l.mode==='rgb')return new THREE.Color().setHSL(l.hue/360,l.saturation/100,.5);
  const c=kelvinRGB(l.temp).map((v,i)=>v/referenceWhite[i]);
  return new THREE.Color().setRGB(...c,THREE.SRGBColorSpace);
}
function angleText(a){const side=a<0?'左':'右';const v=Math.abs(a);return v<1?'正前方':v===180?'正后方':`${side}${v<=90?'前':'后'} ${Math.round(v<=90?v:180-v)}°`}
function paintRange(el){el.style.setProperty('--progress',`${100*(el.value-el.min)/(el.max-el.min)}%`)}

const rangeKeys={power:'power',temperature:'temp',angle:'angle',distance:'distance',height:'height',hue:'hue',saturation:'saturation'};
function rangeValue(id){return id==='exposure'?state.exposure:state.lights[state.selected][rangeKeys[id]]}
function setRangeValue(id,value){if(id==='exposure')state.exposure=value;else state.lights[state.selected][rangeKeys[id]]=value}
function syncNumberInputs(force=false){
  document.querySelectorAll('input[data-range]').forEach(input=>{
    const range=$(input.dataset.range);
    input.min=range.min;input.max=range.max;input.step=range.step||'1';
    input.title=`输入 ${range.min} 到 ${range.max}，按回车确认`;
    if(force||document.activeElement!==input)input.value=rangeValue(range.id);
  });
}

function syncControls(){
  const i=state.selected,l=state.lights[i],s=specs[i];
  $('light-model').textContent=s.model;$('light-desc').textContent=`${s.watts}W · ${s.purpose}`;
  $('light-toggle').classList.toggle('on',l.on);$('light-toggle').setAttribute('aria-checked',String(l.on));$('light-toggle').setAttribute('aria-label',`开启${s.name}`);
  document.querySelectorAll('.light-tab[data-light]').forEach((b,j)=>{b.classList.toggle('active',i===j);b.classList.toggle('off',!state.lights[j].on);b.setAttribute('aria-selected',String(i===j))});
  const map={power:'power',temperature:'temp',angle:'angle',distance:'distance',height:'height',hue:'hue',saturation:'saturation'};
  $('temperature').min=s.min;$('temperature').max=s.max;
  for(const [id,key] of Object.entries(map)){$(id).value=l[key];paintRange($(id))}
  $('power-value').textContent=`${l.power}%`;$('temperature-value').textContent=`${l.temp} K`;
  $('angle-value').textContent=angleText(l.angle);$('distance-value').textContent=`${l.distance.toFixed(2).replace(/0$/,'')} m`;
  $('height-value').textContent=`${l.height.toFixed(2).replace(/0$/,'')} m`;
  $('hue-value').textContent=`${l.hue}°`;$('saturation-value').textContent=`${l.saturation}%`;
  $('temp-min').textContent=`${s.min} K 暖黄`;$('temp-max').textContent=`${s.max} K 冷白`;
  $('color-mode').hidden=i!==2;$('rgb-field').hidden=!(i===2&&l.mode==='rgb');$('temp-field').hidden=i===2&&l.mode==='rgb';
  document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===l.mode));
  const options=i===2?'<option value="bare">裸灯 · 较宽的光线</option><option value="soft">柔光箱 · 阴影更柔和</option>':'<option value="soft">柔光箱 · 阴影更柔和</option><option value="standard">标准罩 · 光线更集中</option>';
  if($('modifier').dataset.lightIndex!==String(i)){$('modifier').innerHTML=options;$('modifier').dataset.lightIndex=i}
  $('modifier').value=l.modifier;
  $('modifier-note').textContent=l.modifier==='soft'?'模拟附件':'原始照度基准';
  $('modifier-hint').textContent=l.modifier==='soft'?'虚拟 60 cm 柔光箱，亮度损耗为估算。':l.modifier==='standard'?'小型标准反光罩，通常会产生更明显的阴影。':'以 RC 60C 裸灯照度为基准。';
  $('exposure').value=state.exposure;paintRange($('exposure'));$('exposure-value').textContent=`${state.exposure>0?'+':''}${state.exposure.toFixed(1).replace('.0','')} EV`;
  $('viewport').dataset.background=state.bg;
  document.querySelectorAll('[data-bg]').forEach(b=>b.classList.toggle('active',b.dataset.bg===state.bg));
  document.querySelectorAll('[data-preset]').forEach(b=>b.classList.toggle('active',b.dataset.preset===state.preset));
  $('scene-caption').textContent=presets[state.preset].caption;$('scene-subcaption').textContent=presets[state.preset].sub;
  syncModelControls();syncNumberInputs();updateReadout();drawMap();
}
function syncModelControls(){
  document.querySelectorAll('[data-model]').forEach(b=>{
    b.classList.toggle('active',b.dataset.model===state.model);
    b.setAttribute('aria-pressed',String(b.dataset.model===state.model));
    b.disabled=!ready||modelLoading;
  });
  $('model-tag').textContent=modelProfiles[state.model].tag;
  $('model-help').textContent=modelLoading?'正在加载写实女模，灯光设置会保留…':modelProfiles[state.model].hint;
  $('model-picker').setAttribute('aria-busy',String(modelLoading));
  $('capture-btn').disabled=!ready||modelLoading;
  $('download-btn').disabled=!ready||modelLoading;
}
async function getPortraitModel(){
  if(modelCache.has('portrait'))return modelCache.get('portrait');
  const gltf=await new GLTFLoader().loadAsync('./assets/portrait-woman.glb');
  const model=gltf.scene;
  model.name='portrait';
  model.traverse(o=>{
    if(!o.isMesh)return;
    o.castShadow=true;o.receiveShadow=true;
    const materials=Array.isArray(o.material)?o.material:[o.material];
    for(const mat of materials){
      if(mat.map)mat.map.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
      if(/Hair|Brows|Lashes/.test(mat.name)){
        mat.transparent=false;mat.alphaTest=.4;mat.side=THREE.DoubleSide;
        mat.shadowSide=THREE.FrontSide;mat.depthWrite=true;
      }
      mat.needsUpdate=true;
    }
  });
  model.visible=false;subject.add(model);modelCache.set('portrait',model);
  return model;
}
async function selectModel(id,{announce=true}={}){
  if(!ready||modelLoading||!Object.hasOwn(modelProfiles,id))return;
  modelLoading=true;syncModelControls();
  try{
    const model=id==='portrait'?await getPortraitModel():modelCache.get('matte');
    for(const item of modelCache.values())item.visible=item===model;
    state.model=id;closeComparison();persist();render();
    if(announce)toast(`已切换到${modelProfiles[id].name}，灯光设置保持不变`);
  }catch(error){
    console.error('Portrait model load failed:',error);
    toast('写实模特暂时无法加载，原模特仍可使用；点击写实女模可重试');
  }finally{modelLoading=false;syncModelControls()}
}
function updateReadout(){
  const i=state.selected,l=state.lights[i];
  $('lux-value').innerHTML=l.mode==='rgb'?'彩色模式 <small>不估算 lux</small>':`${Math.round(luxEstimate(l,i)).toLocaleString('en-US')}<small> lux · 估算</small>`;
  const count=state.lights.filter(l=>l.on&&l.power>0).length;
  $('light-count').textContent=`${count} 盏灯开启`;
  let insight='主灯决定脸的明暗，辅灯轻轻托起阴影，轮廓灯勾出肩颈边缘。';
  const [key,fill,rim]=state.lights;
  if(count===0)insight='三盏灯都熄灭了。先打开主灯，看看光线是怎样让脸部轮廓出现的。';
  else if(!key.on||key.power===0)insight='主灯关了。现在看到的是辅灯或轮廓灯的贡献，可以分别开关它们，辨认各自照亮的地方。';
  else if(!fill.on||fill.power===0)insight='辅灯关了，暗侧脸颊会更深。仔细看看鼻影和下巴，再加一点辅灯来比较。';
  else if(luxEstimate(fill,1)>luxEstimate(key,0)*.85)insight='辅灯已经接近主灯的亮度，两侧脸颊会更均匀。想保留立体感，可以把辅灯调暗一点。';
  else if(l.modifier==='standard')insight='换上标准罩，光更集中，鼻子和下巴的阴影边缘更清楚。换回柔光箱，就能比较软硬。';
  else if(i===2&&rim.on&&rim.mode==='rgb')insight='彩色轮廓光从后侧描亮人物边缘。试着轻轻移动它，观察颜色从耳朵延伸到哪一侧脸颊。';
  else if(l.temp<3800&&l.mode==='cct')insight='色温降低了，灯光偏暖黄。另一盏灯保持 5600 K，可以看见两种色温同时落在脸上的区别。';
  else if(l.temp>6500&&l.mode==='cct')insight='色温升高了，灯光偏冷蓝。白平衡保持不变，方便直接观察冷暖变化。';
  else if(Math.abs(key.angle)>80)insight='主灯移到侧面或后侧了。脸部正面收到的光更少，边缘的亮线会越来越明显。';
  else if(l.height<1.35)insight='灯低于脸部了，鼻影会向上走。把灯稍微升高到眼睛上方，比较两种感觉。';
  else if(!rim.on||rim.power===0)insight='轮廓灯关了。注意肩颈边缘和背景的分界，再打开它，看人物有没有更突出一点。';
  $('insight-text').textContent=insight;
}
function drawMap(){
  $('map-rays').innerHTML=state.lights.map((l,i)=>{const p=lampPosition(l),x=180+p.x*31,y=99+p.z*27;return `<path d="M${x} ${y}L180 99" stroke="${specs[i].color}" stroke-width="${state.selected===i?1.4:.8}" stroke-dasharray="4 4" opacity="${l.on?.6:.18}"/>`}).join('');
  $('map-lamps').innerHTML=state.lights.map((l,i)=>{const p=lampPosition(l),x=180+p.x*31,y=99+p.z*27;return `<g class="map-lamp" data-map-light="${i}" transform="translate(${x} ${y})" role="button" tabindex="0" aria-label="选择并拖动${specs[i].name}"><circle r="19" fill="transparent"/><circle r="${state.selected===i?16:14}" fill="none" stroke="${specs[i].color}" opacity="${state.selected===i?.35:0}"/><circle r="11" fill="${l.on?specs[i].color:'#bfc4b5'}" stroke="#fffefa" stroke-width="2"/><text text-anchor="middle" dominant-baseline="central" fill="white" font-family="Arial" font-size="9">0${i+1}</text></g>`}).join('');
}
function updateLights(){
  if(!ready)return;
  state.lights.forEach((l,i)=>{
    const pos=lampPosition(l),toward=faceCenter.clone().sub(pos).normalize();
    const right=new THREE.Vector3().crossVectors(toward,new THREE.Vector3(0,1,0)).normalize();
    const up=new THREE.Vector3().crossVectors(right,toward).normalize();
    const extent=l.modifier==='soft'?.22:.012;
    const offsets=[[-1,-1],[1,-1],[-1,1],[1,1]];
    rigs[i].forEach((light,j)=>{
      light.position.copy(pos).addScaledVector(right,offsets[j][0]*extent).addScaledVector(up,offsets[j][1]*extent);
      light.color.copy(lightColor(l));
      light.intensity=l.on?specs[i].lux/1100*(l.power/100)*modifierFactor(l)/4:0;
      light.angle=l.modifier==='standard'?rad(24):l.modifier==='soft'?rad(65):rad(75);
      light.penumbra=l.modifier==='standard'?.3:.65;
      light.shadow.radius=l.modifier==='soft'?3:1.1;
      // Keep the shader's light count stable when toggling complex portraits.
      // A switched-off lamp already has zero intensity.
      light.visible=true;
    });
  });
  renderer.toneMappingExposure=Math.pow(2,state.exposure)*1.5;
  render();
}
function render(){if(ready)renderer.render(scene,camera)}
function updateCamera(){
  if(!camera)return;
  const look=new THREE.Vector3(0,1.45,0),d=1.75;
  camera.position.set(Math.sin(state.yaw)*d*Math.cos(state.pitch),1.48+Math.sin(state.pitch)*d,Math.cos(state.yaw)*d*Math.cos(state.pitch));
  camera.lookAt(look);render();
}
function closeComparison(){if(comparing){comparing=false;$('compare-layer').hidden=true;$('compare-divider').hidden=true;$('compare-btn').textContent='对比'}}
function changed(){syncControls();updateLights();persist()}
function selectLight(i){state.selected=i;syncControls();persist()}
function applyPreset(name){state.lights=clone(presets[name].lights);state.preset=name;state.selected=0;state.exposure=0;changed()}

document.querySelectorAll('.light-tab[data-light]').forEach(b=>b.addEventListener('click',()=>selectLight(Number(b.dataset.light))));
document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>{applyPreset(b.dataset.preset);toast(`已切换到「${b.textContent.replace('推荐','').trim()}」`)}));
document.querySelectorAll('[data-model]').forEach(b=>b.addEventListener('click',()=>selectModel(b.dataset.model)));
document.querySelectorAll('input[data-range]').forEach(input=>{
  const id=input.dataset.range;
  input.addEventListener('input',()=>{
    // Keep incomplete input such as an empty field or a minus sign editable.
    if(input.value!==''&&Number.isFinite(input.valueAsNumber)&&input.validity.valid){
      setRangeValue(id,input.valueAsNumber);changed();
    }
  });
  input.addEventListener('blur',()=>{
    const value=input.valueAsNumber,range=$(id);
    if(input.value===''||!Number.isFinite(value)){input.value=rangeValue(id);return}
    const min=Number(range.min),max=Number(range.max),step=Number(range.step)||1;
    const normalized=Number(clamp(min+Math.round((clamp(value,min,max)-min)/step)*step,min,max).toFixed(6));
    setRangeValue(id,normalized);input.value=normalized;changed();
    if(value<min||value>max)toast(`可输入范围是 ${min} 至 ${max}，已调整为 ${normalized}`);
  });
  input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();input.blur()}});
});
for(const [id,key] of Object.entries({power:'power',temperature:'temp',angle:'angle',distance:'distance',height:'height',hue:'hue',saturation:'saturation'})){
  $(id).addEventListener('input',e=>{state.lights[state.selected][key]=Number(e.target.value);changed()});
}
$('light-toggle').addEventListener('click',()=>{state.lights[state.selected].on=!state.lights[state.selected].on;changed()});
$('modifier').addEventListener('change',e=>{state.lights[state.selected].modifier=e.target.value;changed()});
document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>{state.lights[2].mode=b.dataset.mode;changed()}));
$('exposure').addEventListener('input',e=>{state.exposure=Number(e.target.value);changed()});
document.querySelectorAll('[data-bg]').forEach(b=>b.addEventListener('click',()=>{state.bg=b.dataset.bg;changed()}));
$('reset-btn').addEventListener('click',()=>{state.bg='warm';state.yaw=0;state.pitch=0;closeComparison();applyPreset('natural');updateCamera();toast('已回到自然人像的初始布光')});
$('front-btn').addEventListener('click',()=>{state.yaw=0;state.pitch=0;closeComparison();updateCamera();$('view-hint').textContent='↔ 拖动人物区域，换个角度观察'});
for(const [button,dialog] of [['about-btn','about-dialog'],['specs-btn','specs-dialog'],['meter-info','specs-dialog']])$(button).addEventListener('click',()=>$(dialog).showModal());
document.querySelectorAll('dialog').forEach(d=>{d.querySelectorAll('.dialog-close,.dialog-close-button').forEach(b=>b.addEventListener('click',()=>d.close()));d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()}})});

let mapDrag=null;
$('light-map').addEventListener('pointerdown',e=>{
  const el=e.target.closest('[data-map-light]');if(!el)return;
  mapDrag=Number(el.dataset.mapLight);selectLight(mapDrag);$('light-map').setPointerCapture(e.pointerId);e.preventDefault();
});
$('light-map').addEventListener('pointermove',e=>{
  if(mapDrag===null)return;
  const svg=$('light-map').querySelector('svg'),p=new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  const x=(p.x-180)/31,z=(p.y-99)/27;
  state.lights[mapDrag].angle=Math.round(Math.atan2(x,z)*180/Math.PI);
  state.lights[mapDrag].distance=Math.round(clamp(Math.hypot(x,z),.6,3)*20)/20;
  changed();
});
for(const event of ['pointerup','pointercancel','lostpointercapture'])$('light-map').addEventListener(event,()=>{mapDrag=null});
$('light-map').addEventListener('keydown',e=>{const el=e.target.closest('[data-map-light]');if(el&&['Enter',' '].includes(e.key)){e.preventDefault();selectLight(Number(el.dataset.mapLight));$('angle').focus()}});

const lessons=[
  '从只开主灯开始。留意鼻子旁和另一侧脸颊的阴影：光从哪边来，阴影就会落在相反的一边。',
  '保留主灯，慢慢把辅灯从 0% 加到 50%。看暗侧脸颊逐渐变亮，找到既能看清细节、又保留立体感的位置。',
  '保留前面两盏灯，打开后侧的轮廓灯。留意耳朵、颈部与肩膀边缘，试着找到一条轻轻亮起的线。',
  '先只有一盏主灯，把“离人物多远”从 1.5 m 拉到 0.75 m。保持亮度不变，观察靠近后画面变亮的程度，再拉远比较。'
];
document.querySelectorAll('[data-lesson]').forEach(b=>b.addEventListener('click',()=>{lesson=Number(b.dataset.lesson);document.querySelectorAll('[data-lesson]').forEach(x=>x.classList.toggle('active',x===b));$('lesson-text').textContent=lessons[lesson]}));
$('lesson-apply').addEventListener('click',()=>{
  applyPreset('natural');
  if(lesson===0||lesson===3){state.lights[1].on=false;state.lights[2].on=false;state.selected=0}
  if(lesson===1){state.lights[1].power=0;state.lights[2].on=false;state.selected=1}
  if(lesson===2){state.lights[2].on=false;state.selected=2}
  changed();$('viewport').scrollIntoView({behavior:'smooth',block:'center'});
  toast(['已只开主灯，试着左右移动它','辅灯从 0% 开始，请慢慢增加亮度','轮廓灯已关闭，点击开关试试看','已只开主灯，试着把距离缩短'][lesson]);
});

function snapshot(){
  render();
  const canvas=document.createElement('canvas');canvas.width=renderer.domElement.width;canvas.height=renderer.domElement.height;
  const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  const colors={warm:['#c0b7a8','#817e76'],light:['#eeeeea','#c8cbc4'],dark:['#50554f','#242a27']}[state.bg];
  const g=ctx.createRadialGradient(w*.5,h*.41,0,w*.5,h*.41,Math.max(w,h)*.67);g.addColorStop(0,colors[0]);g.addColorStop(1,colors[1]);ctx.fillStyle=g;ctx.fillRect(0,0,w,h);ctx.drawImage(renderer.domElement,0,0);return canvas;
}
$('capture-btn').addEventListener('click',()=>{
  if(!ready||modelLoading)return;
  closeComparison();capture={state:clone(state),image:snapshot().toDataURL('image/png')};$('compare-btn').disabled=false;$('capture-btn').textContent='▣ 更新记录';toast('已记住当前画面。调整灯光后，点击「对比」查看变化。');
});
$('compare-btn').addEventListener('click',()=>{
  if(!capture||!ready)return;
  comparing=!comparing;
  if(comparing){state.yaw=capture.state.yaw;state.pitch=capture.state.pitch;updateCamera();$('compare-img').src=capture.image}
  $('compare-layer').hidden=!comparing;$('compare-divider').hidden=!comparing;$('compare-btn').textContent=comparing?'结束对比':'对比';
});
$('download-btn').addEventListener('click',()=>{
  if(!ready||modelLoading)return;
  const c=snapshot(),ctx=c.getContext('2d');ctx.fillStyle='#fff9';ctx.font=`${Math.round(c.width/85)}px Arial`;ctx.fillText('LIGHT STUDY · 光感',c.width*.045,c.height*.96);
  c.toBlob(blob=>{if(!blob){toast('画面导出失败，请重试');return}const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=`光感-${presets[state.preset].sub.split('/')[0].trim().toLowerCase().replaceAll(' ','-')}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);toast('已导出当前人像画面')},'image/png');
});

async function initScene(){
  renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,1.5));renderer.setClearColor(0x000000,0);
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.domElement.setAttribute('aria-label','实时三维人物：按住鼠标拖动来旋转视角');renderer.domElement.setAttribute('role','img');
  $('viewport').prepend(renderer.domElement);
  scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(27,1,.03,20);subject=new THREE.Group();scene.add(subject);
  const skin=new THREE.MeshStandardMaterial({color:0xd8cec0,roughness:.78,metalness:0});
  const gltf=await new GLTFLoader().loadAsync('./assets/head.glb');
  const head=gltf.scene;head.updateMatrixWorld(true);
  const bounds=new THREE.Box3().setFromObject(head),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3()),scale=.72/size.y;
  head.scale.setScalar(scale);head.position.set(-center.x*scale,1.38-center.y*scale,-center.z*scale);
  head.traverse(o=>{if(o.isMesh){o.material=skin;o.castShadow=true;o.receiveShadow=true}});subject.add(head);modelCache.set('matte',head);
  for(let i=0;i<3;i++){
    const group=[];
    for(let j=0;j<4;j++){
      const light=new THREE.SpotLight(0xffffff,1,0,rad(60),.5,2);light.castShadow=true;
      light.shadow.mapSize.set(1024,1024);light.shadow.camera.near=.05;light.shadow.camera.far=6;light.shadow.bias=-.00008;light.shadow.normalBias=.0008;
      light.target.position.copy(faceCenter);scene.add(light,light.target);group.push(light);
    }
    rigs.push(group);
  }
  ready=true;
  function resize(){const el=$('viewport');renderer.setSize(el.clientWidth,el.clientHeight,false);camera.aspect=el.clientWidth/el.clientHeight;camera.updateProjectionMatrix();render()}
  new ResizeObserver(resize).observe($('viewport'));resize();updateCamera();updateLights();$('loading').hidden=true;
  const requestedModel=state.model;state.model='matte';syncModelControls();
  if(requestedModel==='portrait')await selectModel('portrait',{announce:false});
  let dragging=null;
  renderer.domElement.addEventListener('pointerdown',e=>{closeComparison();dragging={x:e.clientX,y:e.clientY,yaw:state.yaw,pitch:state.pitch};renderer.domElement.setPointerCapture(e.pointerId)});
  renderer.domElement.addEventListener('pointermove',e=>{if(!dragging)return;state.yaw=dragging.yaw-(e.clientX-dragging.x)*.008;state.pitch=clamp(dragging.pitch+(e.clientY-dragging.y)*.004,-.2,.42);updateCamera();$('view-hint').textContent='自由观察中 · 点击右上角回到正面'});
  for(const event of ['pointerup','pointercancel','lostpointercapture'])renderer.domElement.addEventListener(event,()=>{dragging=null});
  renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();ready=false;$('loading').hidden=false;$('loading').textContent='图形连接中断，请刷新页面重新进入摄影棚。'});
}
syncControls();
initScene().catch(error=>{console.error('Studio initialization failed:',error);$('loading').innerHTML='<div style="text-align:center;max-width:290px;line-height:1.9;padding:24px">暂时无法打开 3D 摄影棚。<br>请使用支持 WebGL 2 的新版浏览器，并开启图形加速。<br><button id="retry-load" class="primary-button" style="margin-top:18px">重新加载</button></div>';$('retry-load').addEventListener('click',()=>location.reload())});
