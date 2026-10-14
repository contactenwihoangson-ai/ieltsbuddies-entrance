'use strict';
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const E = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stages = ['listening','reading','writing','speaking'];
const labels = ['Listening','Reading','Writing','Speaking'];
const app = $('#app');
let mode='student', sessionRole='guest', adminTab='overview', editPart='listening';
let draft=null, codes=[], attempts=[], currentDetail=null;
let state=null, testAnswers={}, autosaveTimer=null, savePending=Promise.resolve(), lastSaveText='Bài làm được lưu tự động';
let recorder=null, recStream=null, recChunks=[], recBlob=null, recUrl=null, uploading=false, recording=false, recSeconds=0, recInterval=null;
let timerInterval=null, deadlineAnchor=null;

function toast(message, bad=false){const el=$('#toast');el.textContent=message;el.className='toast show'+(bad?' bad':'');clearTimeout(el.hideTimer);el.hideTimer=setTimeout(()=>el.classList.remove('show'),4200)}
async function api(path, options={}){
  const cfg={credentials:'same-origin',...options};
  if (cfg.body && !(cfg.body instanceof FormData)){cfg.headers={'Content-Type':'application/json',...cfg.headers};cfg.body=JSON.stringify(cfg.body)}
  let response;
  try {response=await fetch('/api'+path,cfg)} catch(e){throw new Error('Không thể kết nối máy chủ. Kiểm tra kết nối mạng.')}
  const type=response.headers.get('content-type')||'';
  const data=type.includes('json')?await response.json():await response.text();
  if(!response.ok)throw new Error((typeof data==='object'&&data.detail)||'Có lỗi xảy ra');
  return data;
}
function header(adminLink=true){return `<header class="topbar"><div class="shell topbar-inner"><a href="#" class="brand" id="homeBrand"><span class="brand-mark">IB.</span><span class="brand-text">IELTS Buddies <small>ENTRANCE ASSESSMENT</small></span></a><div class="top-actions">${adminLink?`<button class="plainbtn" id="modeSwitch">${mode==='admin'?'Trang học sinh':'Dành cho quản trị viên'} ↗</button>`:''}${sessionRole!=='guest'?`<button class="btn secondary sm" id="logoutBtn">Đăng xuất</button>`:''}</div></div></header>`}
function bindHeader(){
  $('#homeBrand')?.addEventListener('click',e=>{e.preventDefault();showCurrent()});
  $('#modeSwitch')?.addEventListener('click',()=>{mode=mode==='admin'?'student':'admin';showCurrent()});
  $('#logoutBtn')?.addEventListener('click',async()=>{if(recording)stopRecording();await api('/logout',{method:'POST'});sessionRole='guest';state=null;draft=null;currentDetail=null;mode='student';clearInterval(timerInterval);showCurrent()});
}
function loginView(){
  const admin=mode==='admin';
  app.innerHTML=header()+`<main class="shell page"><div class="login-wrap"><section class="intro"><span class="overline">${admin?'TEACHER WORKSPACE':'YOUR ENGLISH JOURNEY STARTS HERE'}</span><h1>${admin?'One place to manage every assessment.':'A clearer way to discover your English level.'}</h1><p>${admin?'Tự soạn nội dung bài thi, phát mã dự thi, theo dõi bài làm và chấm điểm trong một giao diện trực quan.':'Một bài kiểm tra, bốn kỹ năng. Tập trung vào từng phần và thể hiện đúng năng lực tiếng Anh của bạn.'}</p><div class="skill-stack">${labels.map((label,i)=>`<div class="skill-chip"><span>0${i+1} &nbsp; ${label}</span><span>↗</span></div>`).join('')}</div></section><section class="login-card"><span class="overline">${admin?'ADMIN ACCESS':'CANDIDATE SIGN IN'}</span><h2>${admin?'Đăng nhập quản trị':'Sẵn sàng bắt đầu?'}</h2><p class="muted">${admin?'Chỉ giáo viên có quyền truy cập phần quản lý và kết quả.':'Nhập thông tin được giáo viên cung cấp trước khi vào bài thi.'}</p><form id="loginForm">${admin?`<div class="field"><label for="adminPassword">Mật khẩu quản trị</label><input class="input" type="password" autocomplete="current-password" id="adminPassword" placeholder="Nhập mật khẩu" required/></div>`:`<div class="field"><label for="candidateCode">Mã dự thi</label><input class="input" autocomplete="off" autocapitalize="characters" id="candidateCode" placeholder="Ví dụ: A1B2C3D4" maxlength="20" required/></div><div class="field"><label for="candidateName">Họ và tên</label><input class="input" autocomplete="name" id="candidateName" placeholder="Nhập họ và tên đầy đủ" maxlength="100" required/></div>`}<button class="btn full" type="submit" id="loginSubmit">${admin?'Vào trang quản trị':'Bắt đầu bài kiểm tra'} <span>→</span></button><div id="loginError" class="error" aria-live="polite"></div></form><div class="form-hint">${admin?'Bài thi chỉ hiển thị cho học sinh sau khi được xuất bản. Điểm và bản ghi Speaking không hiển thị ở trang học sinh.':'<b>Lưu ý:</b> Đồng hồ bắt đầu chạy khi bạn đăng nhập lần đầu. Bạn sẽ làm bài theo thứ tự Listening → Reading → Writing → Speaking. Kết quả không hiển thị ngay sau khi nộp.'}</div></section></div><div class="footer-note">IELTS Buddies · Designed for focused assessment</div></main>`;
  bindHeader();
  $('#loginForm').addEventListener('submit',async e=>{
    e.preventDefault();const button=$('#loginSubmit');button.disabled=true;$('#loginError').textContent='';
    try{
      if(admin){await api('/admin/login',{method:'POST',body:{password:$('#adminPassword').value}});sessionRole='admin';await loadAdmin();}
      else{await api('/student/login',{method:'POST',body:{code:$('#candidateCode').value,name:$('#candidateName').value}});sessionRole='student';await loadStudent();}
    }catch(err){$('#loginError').textContent=err.message;button.disabled=false;}
  });
}
async function init(){try{const result=await api('/session');sessionRole=result.role;mode=result.role==='admin'?'admin':'student';if(sessionRole==='admin')await loadAdmin();else if(sessionRole==='student')await loadStudent();else loginView()}catch(e){app.innerHTML='<div class="loading-screen">Không thể kết nối máy chủ. Vui lòng kiểm tra cấu hình.</div>';toast(e.message,true)}}
function showCurrent(){if(mode==='admin'){if(sessionRole==='admin'&&draft)renderAdmin();else loginView();}else{if(sessionRole==='student'&&state)renderStudent();else loginView();}}
async function loadAdmin(){[draft,codes,attempts]=await Promise.all([api('/admin/config'),api('/admin/codes'),api('/admin/attempts')]);renderAdmin()}
async function loadStudent(){state=await api('/student/state');testAnswers=state.answers||{};renderStudent();startTimer()}
function timeFormat(seconds){const s=Math.max(0,Math.ceil(seconds));return [Math.floor(s/3600),Math.floor(s%3600/60),s%60].map(n=>String(n).padStart(2,'0')).join(':')}
function startTimer(){clearInterval(timerInterval);deadlineAnchor={seconds:Math.max(0,state.deadline_at-state.server_time),at:performance.now()};function tick(){const el=$('#timerValue');const rem=deadlineAnchor.seconds-(performance.now()-deadlineAnchor.at)/1000;if(el)el.textContent=timeFormat(rem);if(rem<=0){clearInterval(timerInterval);loadStudent().catch(()=>{});}}tick();timerInterval=setInterval(tick,1000)}
function progress(index){return `<div class="progress-wrap">${labels.map((name,i)=>`<div class="progress-step ${i===index?'current':i<index?'past':''}"><span class="progress-number">${i<index?'✓':i+1}</span><span>${name}</span></div>`).join('')}</div>`}
function examHeader(){const index=state.stage_index;return `${header(false)}<div class="exam-top"><div class="shell"><div class="exam-meta"><div class="candidate">${E(state.name)}<small>Candidate ID: ${E(state.code)}</small></div><div class="clock"><span class="clock-label">Thời gian còn lại</span><span id="timerValue">--:--:--</span></div></div>${progress(index)}</div></div>`}
function qCard(q, number, section){
  const v=testAnswers[section]?.[q.id]||'';
  const inputs=q.type==='choice'?`<div class="options">${(q.options||[]).map((option,j)=>`<label class="option"><input type="radio" name="q_${E(q.id)}" data-q="${E(q.id)}" data-section="${section}" value="${'ABCD'[j]||String(j)}" ${v===('ABCD'[j]||String(j))?'checked':''}/><span><b>${'ABCD'[j]||j+1}.</b> ${E(option)}</span></label>`).join('')}</div>`:`<input class="input answer-input" data-q="${E(q.id)}" data-section="${section}" placeholder="Type your answer here" value="${E(v)}" autocomplete="off"/>`;
  return `<div class="qcard"><div class="qtop"><span class="qnum">${number}</span><div class="qtitle">${E(q.prompt)}</div></div>${inputs}</div>`;
}
function examBody(){const section=stages[state.stage_index], ex=state.exam;
  const headings={listening:['Listening','Nghe audio và hoàn thành các câu hỏi bên dưới.'],reading:['Reading','Đọc đoạn văn và trả lời câu hỏi.'],writing:['Writing','Trình bày câu trả lời bằng tiếng Anh.'],speaking:['Speaking','Ghi âm câu trả lời của bạn.']};
  let body='';
  if(section==='listening'){
    body=`<div class="card card-pad"><div class="overline">AUDIO INSTRUCTIONS</div><p style="margin:10px 0 0">${E(ex.listening_instructions)}</p><div class="audio-panel"><div class="audio-icon">♫</div><div class="audio-info"><strong>Listening audio</strong><span class="tiny">Nghe và điền đáp án</span></div><audio controls controlsList="nodownload" preload="metadata" src="/api/media/listening/${encodeURIComponent(ex.listening_audio||'')}"></audio></div></div><div class="questions">${ex.listening_questions.map((q,i)=>qCard(q,i+1,'listening')).join('')}</div>`;
  }else if(section==='reading'){
    body=`<div class="reading-layout"><section class="card reading-text"><span class="overline">READING PASSAGE</span><p class="muted" style="margin-top:13px">${E(ex.reading_instructions)}</p><div class="passage">${E(ex.reading_passage)}</div></section><section class="questions">${ex.reading_questions.map((q,i)=>qCard(q,i+1,'reading')).join('')}</section></div>`;
  }else if(section==='writing'){
    const saved=testAnswers.writing||'';
    body=`<div class="writing-layout"><section class="card writing-prompt"><span class="overline">WRITING TASK</span><h3 style="margin:14px 0">Your task</h3><p>${E(ex.writing_prompt)}</p>${ex.writing_min_words?`<div class="hint-box">Suggested minimum: <strong>${Number(ex.writing_min_words)} words</strong></div>`:''}</section><section class="card writing-editor"><div class="writing-toolbar"><span>YOUR RESPONSE</span><span id="wordCount">${wordCount(saved)} words</span></div><textarea id="essayText" class="essay" spellcheck="true" placeholder="Start typing your response here...">${E(saved)}</textarea></section></div>`;
  }else{
    body=`<div class="speaking-wrap"><section class="card speaking-stage"><div class="mic-icon">♩</div><span class="overline">SPEAKING ASSESSMENT</span><h2 style="margin:12px 0 10px">Your speaking task</h2><p class="muted">Đọc câu hỏi, chuẩn bị và ghi âm câu trả lời của bạn.</p><div class="prompt-box">${E(ex.speaking_prompt)}</div>${ex.speaking_preparation_seconds?`<p class="tiny">Thời gian chuẩn bị gợi ý: ${E(ex.speaking_preparation_seconds)} giây (không khóa nút ghi âm).</p>`:''}<div id="recordStatus">${state.speaking_recorded?'<span class="status">✓ Bản ghi đã được tải lên</span>':'<span class="muted">Microphone chưa bật</span>'}</div><div class="rec-actions" style="margin-top:20px"><button class="btn" id="startRecording">● Bắt đầu ghi âm</button><button class="btn danger" id="stopRecording" disabled>■ Dừng ghi âm</button></div><div id="recordPreview" class="rec-playback">${state.speaking_recorded?'<audio controls style="width:100%" src="/api/media/speaking/self"></audio>':''}</div><p class="tiny" style="margin-top:22px">Bạn có thể nghe lại và ghi âm lại trước khi nộp. Bản ghi sẽ được giáo viên sử dụng để chấm bài. Hãy cho phép truy cập microphone.</p></section></div>`;
  }
  return `<div class="exam-main shell"><div class="section-head"><div><span class="overline">SECTION ${String(state.stage_index+1).padStart(2,'0')} / 04</span><h1>${headings[section][0]}</h1><p>${headings[section][1]}</p></div><span class="pill">${section==='listening'?ex.listening_questions.length+' questions':section==='reading'?ex.reading_questions.length+' questions':'Your response'}</span></div>${body}</div>`;
}
function wordCount(str){return str.trim()?str.trim().split(/\s+/).length:0}
function renderStudent(){
  clearInterval(timerInterval);
  if(state.status==='submitted'){
    app.innerHTML=header(false)+`<main class="shell page"><div class="card card-pad done"><div class="done-icon">✓</div><span class="overline">ASSESSMENT COMPLETED</span><h1 style="margin:16px 0">Bài thi đã được nộp</h1><p>Cảm ơn <strong>${E(state.name)}</strong> đã hoàn thành bài kiểm tra. Câu trả lời và bản ghi Speaking đã được gửi đến giáo viên.</p><p class="muted">Kết quả sẽ được giáo viên đánh giá và thông báo riêng. Trang này không hiển thị điểm số.</p><div class="hint-box" style="margin-top:25px">Mã dự thi: <b>${E(state.code)}</b> · Trạng thái: Đã nộp</div></div></main>`;
    bindHeader();return;
  }
  const last=state.stage_index===3;
  app.innerHTML=examHeader()+examBody()+`<footer class="exam-footer"><div class="shell footer-inner"><div class="save-state"><span style="color:var(--green)">●</span><span id="saveIndicator">${E(last?'Bản ghi được lưu sau khi tải lên':lastSaveText)}</span></div><button class="btn" id="nextButton">${last?'Nộp bài thi':'Tiếp tục: '+labels[state.stage_index+1]} <span>→</span></button></div></footer>`;
  bindHeader();bindStudentFields();if(deadlineAnchor)startTimer();
}
function bindStudentFields(){
  $$('[data-q]').forEach(el=>el.addEventListener('input',e=>{const {q,section}=e.target.dataset;testAnswers[section]??={};testAnswers[section][q]=e.target.value;scheduleSave()}));
  $('#essayText')?.addEventListener('input',e=>{testAnswers.writing=e.target.value;$('#wordCount').textContent=wordCount(e.target.value)+' words';scheduleSave()});
  $('#startRecording')?.addEventListener('click',startRecording);
  $('#stopRecording')?.addEventListener('click',stopRecording);
  $('#nextButton').addEventListener('click',async()=>{
    const btn=$('#nextButton');if(uploading||recording){toast('Hãy dừng ghi âm và hoàn tất tải lên trước.',true);return}
    btn.disabled=true;
    try{
      clearTimeout(autosaveTimer);if(state.stage_index<3)await saveCurrent();
      if(state.stage_index===3){
        if(!state.speaking_recorded){toast('Bạn cần ghi âm Speaking trước khi nộp bài.',true);btn.disabled=false;return}
        if(!confirm('Xác nhận nộp cả 4 kỹ năng? Bạn sẽ không thể chỉnh sửa bài làm.')){btn.disabled=false;return}
      }
      await api('/student/advance',{method:'POST'});recBlob=null;recUrl=null;await loadStudent();
      window.scrollTo({top:0,behavior:'smooth'});
    }catch(err){toast(err.message,true);btn.disabled=false;}
  });
}
function scheduleSave(){lastSaveText='Đang lưu...';if($('#saveIndicator'))$('#saveIndicator').textContent=lastSaveText;clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>{saveCurrent().catch(err=>toast(err.message,true))},850)}
async function saveCurrent(){if(!state||state.stage_index>=3||state.status!=='in_progress')return;
  const stage=stages[state.stage_index];const data=stage==='writing'?{stage,text:testAnswers.writing||''}:{stage,answers:{...(testAnswers[stage]||{})}};
  const activeSave=savePending.catch(()=>{}).then(()=>api('/student/answers',{method:'PUT',body:data}));savePending=activeSave;await activeSave;
  lastSaveText='Đã lưu bài làm';if($('#saveIndicator'))$('#saveIndicator').textContent=lastSaveText;
}
async function startRecording(){
  if(uploading){toast('Đang tải bản ghi trước đó, vui lòng hoàn tất trước.',true);return}
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){toast('Trình duyệt không hỗ trợ ghi âm. Hãy dùng Chrome hoặc Edge trên HTTPS.',true);return}
  try{
    recStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
    const opts=MediaRecorder.isTypeSupported('audio/webm')?{mimeType:'audio/webm'}:{};
    recorder=new MediaRecorder(recStream,opts);recChunks=[];recSeconds=0;recording=true;
    recorder.ondataavailable=e=>{if(e.data.size)recChunks.push(e.data)};
    recorder.onstop=async()=>{
      recording=false;clearInterval(recInterval);recStream?.getTracks().forEach(t=>t.stop());
      recBlob=new Blob(recChunks,{type:recorder.mimeType||'audio/webm'});
      if(recUrl)URL.revokeObjectURL(recUrl);recUrl=URL.createObjectURL(recBlob);
      $('#recordPreview').innerHTML=`<audio controls style="width:100%" src="${recUrl}"></audio>`;
      $('#recordStatus').innerHTML='<span class="muted">Đang tải bản ghi lên máy chủ...</span>';
      uploading=true;$('#nextButton').disabled=true;$('#startRecording').disabled=true;
      const file=new File([recBlob],'speaking.'+(recorder.mimeType.includes('mp4')?'mp4':recorder.mimeType.includes('ogg')?'ogg':'webm'),{type:recorder.mimeType});
      const form=new FormData();form.append('file',file);
      try{await api('/student/speaking',{method:'POST',body:form});state.speaking_recorded=true;$('#recordStatus').innerHTML='<span class="status">✓ Đã lưu bản ghi lên hệ thống</span>';toast('Đã tải ghi âm Speaking thành công')}
      catch(err){$('#recordStatus').innerHTML=`<span class="error">${E(err.message)}. Vui lòng ghi âm lại.</span>`;toast(err.message,true)}
      finally{uploading=false;$('#nextButton').disabled=false;$('#startRecording').disabled=false}
    };
    recorder.start(1000);
    $('#startRecording').disabled=true;$('#stopRecording').disabled=false;
    $('#recordStatus').innerHTML='<span class="rec-indicator"><span class="rec-dot"></span><span id="recElapsed">00:00</span> · Đang ghi âm</span>';
    recInterval=setInterval(()=>{recSeconds++;const el=$('#recElapsed');if(el)el.textContent=String(Math.floor(recSeconds/60)).padStart(2,'0')+':'+String(recSeconds%60).padStart(2,'0')},1000);
  }catch(err){toast('Không truy cập được microphone. Hãy kiểm tra quyền truy cập và thử lại.',true);recStream?.getTracks().forEach(t=>t.stop())}
}
function stopRecording(){if(recorder&&recording&&recorder.state!=='inactive'){recorder.stop();$('#startRecording').disabled=false;$('#stopRecording').disabled=true}}

function adminNav(){const nav=[['overview','▦','Tổng quan'],['editor','✎','Soạn đề thi'],['codes','#','Mã dự thi'],['submissions','▤','Bài nộp & chấm điểm']];return `<aside class="sidebar"><div class="sidebar-title">Workspace</div>${nav.map(([key,icon,label])=>`<button class="nav-item ${adminTab===key?'active':''}" data-tab="${key}"><span class="nav-glyph">${icon}</span>${label}</button>`).join('')}</aside>`}
function renderAdmin(){if(mode!=='admin')return loginView();let contents='';
  if(currentDetail){renderDetail();return}
  if(adminTab==='overview')contents=overviewView();
  else if(adminTab==='editor')contents=editorView();
  else if(adminTab==='codes')contents=codesView();
  else contents=submissionsView();
  app.innerHTML=header()+`<main class="shell page"><div class="admin-layout">${adminNav()}<div>${contents}</div></div><div class="footer-note">IELTS Buddies · Private admin workspace</div></main>`;
  bindHeader();$$('[data-tab]').forEach(btn=>btn.addEventListener('click',()=>{adminTab=btn.dataset.tab;renderAdmin()}));
  if(adminTab==='editor')bindEditor();if(adminTab==='codes')bindCodes();if(adminTab==='submissions'||adminTab==='overview')bindAttempts();
}
function dateString(timestamp){return timestamp?new Date(timestamp*1000).toLocaleString('vi-VN'):'—'}
function statusBadge(a){return a.status==='submitted'?'<span class="status">✓ Đã nộp</span>':'<span class="status pending">◷ Đang làm</span>'}
function attemptTable(list){if(!list.length)return '<div class="empty">Chưa có học sinh bắt đầu làm bài.<br/>Tạo mã dự thi và chia sẻ cho học sinh để bắt đầu.</div>';
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Học sinh</th><th>Mã</th><th>Trạng thái</th><th>Trắc nghiệm</th><th></th></tr></thead><tbody>${list.map(a=>`<tr><td><b>${E(a.name)}</b><div class="tiny">${E(dateString(a.started_at))}</div></td><td class="code-text">${E(a.code)}</td><td>${statusBadge(a)}</td><td>${a.objective.correct}/${a.objective.total}</td><td><button class="btn soft sm" data-attempt="${E(a.id)}">Xem bài →</button></td></tr>`).join('')}</tbody></table></div>`}
function overviewView(){const done=attempts.filter(a=>a.status==='submitted').length;
  return `<div class="admin-head"><div><span class="overline">ADMIN DASHBOARD</span><h1 style="margin-top:8px">Tổng quan bài kiểm tra</h1><p class="muted" style="margin:0">Theo dõi tiến độ và quản lý bài làm.</p></div><span class="status ${draft.published?'':'draft'}">${draft.published?'● Đề đang mở':'● Bản nháp'}</span></div><div class="stats"><div class="stat"><p>Mã dự thi đã tạo</p><strong>${codes.length}</strong></div><div class="stat"><p>Học sinh đã bắt đầu</p><strong>${attempts.length}</strong></div><div class="stat"><p>Bài đã nộp</p><strong>${done}</strong></div></div><div class="card"><div class="card-pad info-row"><div><h3 style="margin:0 0 5px">Bài làm gần đây</h3><span class="tiny">Chỉ admin có quyền xem câu trả lời và điểm số</span></div><button class="btn secondary sm" id="refreshOverview">Làm mới</button></div>${attemptTable(attempts.slice(0,6))}</div>`;
}
function editorView(){return `<div class="admin-head"><div><span class="overline">EXAM BUILDER</span><h1 style="margin-top:8px">Thiết lập đề thi</h1><p class="muted" style="margin:0">Tất cả nội dung được nhập thủ công. Hệ thống không tự sinh đề.</p></div><button class="btn" id="saveExam">Lưu thay đổi</button></div><div class="card editor-intro"><div><h3 style="margin-bottom:8px">${E(draft.title)}</h3><p><b>${Number(draft.duration_minutes)} phút</b> · ${draft.listening_questions.length+draft.reading_questions.length} câu hỏi khách quan · 4 kỹ năng</p></div><label class="checkbox-row"><input type="checkbox" id="publishSwitch" ${draft.published?'checked':''}/> Xuất bản đề</label></div><div class="card"><div class="tabs">${[['general','Thiết lập chung'],['listening','Listening'],['reading','Reading'],['writing','Writing'],['speaking','Speaking']].map(([k,l])=>`<button class="tab ${editPart===k?'selected':''}" data-part="${k}">${l}</button>`).join('')}</div><div class="editor-panel">${partView()}</div></div><div class="hint-box" style="margin-top:20px">Để xuất bản, cần có audio + câu hỏi Listening, bài đọc + câu hỏi Reading, đề Writing và câu hỏi Speaking. Đề đang làm của học sinh được giữ nguyên ngay cả khi admin cập nhật phiên bản mới.</div>`}
function textField(label,key,help='',height=100){return `<div class="field"><label>${label}</label><textarea class="textarea" style="min-height:${height}px" data-config="${key}" placeholder="${E(help)}">${E(draft[key]||'')}</textarea></div>`}
function questionBuilder(part){const qs=draft[part+'_questions'];return `<hr class="rule"/><div class="info-row" style="margin-bottom:20px"><div><h3 style="margin:0 0 5px">Câu hỏi</h3><span class="tiny">Hỗ trợ MCQ, True/False/Not Given, Yes/No/Not Given, điền từ.</span></div><button class="btn soft sm" id="addQuestion">+ Thêm câu hỏi</button></div>${qs.length?qs.map((q,i)=>`<div class="question-editor"><div class="q-editor-top"><b>Question ${i+1}</b><button class="btn danger sm" data-deleteq="${i}">Xóa</button></div><div class="field"><label>Nội dung câu hỏi</label><textarea class="textarea" style="min-height:76px" data-qi="${i}" data-qfield="prompt" placeholder="Nhập nội dung câu hỏi">${E(q.prompt)}</textarea></div><div class="inline-fields"><div class="field"><label>Dạng câu hỏi</label><select class="select" data-qi="${i}" data-qfield="type"><option value="choice" ${q.type==='choice'?'selected':''}>Chọn đáp án (MCQ)</option><option value="short" ${q.type==='short'?'selected':''}>Short answer / Gap fill</option></select></div>${q.type==='choice'?`<div class="field"><label>Đáp án chính xác</label><select class="select" data-qi="${i}" data-qfield="answer">${['A','B','C','D'].map(v=>`<option value="${v}" ${q.answer===v?'selected':''}>${v}</option>`).join('')}</select></div>`:`<div class="field"><label>Đáp án chấp nhận được</label><input class="input" data-qi="${i}" data-qfield="answer" value="${E(q.answer)}" placeholder="Ví dụ: train | trains"/></div>`}</div>${q.type==='choice'?`<div class="choice-grid">${['A','B','C','D'].map((letter,j)=>`<div class="field"><label>Option ${letter}</label><input class="input" data-qi="${i}" data-opt="${j}" value="${E(q.options?.[j]||'')}" placeholder="Nội dung lựa chọn ${letter}"/></div>`).join('')}</div>`:''}</div>`).join(''):'<div class="hint-box">Chưa có câu hỏi. Chọn “Thêm câu hỏi” để nhập câu hỏi và đáp án.</div>'}`}
function partView(){switch(editPart){
  case 'general':return `<h3>Thông tin bài thi</h3><div class="field"><label>Tên bài thi</label><input class="input" data-config="title" value="${E(draft.title)}"/></div><div class="field"><label>Thời lượng toàn bài (phút)</label><input class="input" type="number" data-config="duration_minutes" min="5" max="240" value="${Number(draft.duration_minutes)}"/></div><div class="hint-box">Thời gian tính từ lần đăng nhập đầu tiên, kể cả khi thoát khỏi trang. Hệ thống khóa bài sau khi hết giờ.</div>`;
  case 'listening':return `<h3>Nội dung Listening</h3>${textField('Hướng dẫn cho học sinh','listening_instructions','Ví dụ: Answer the following questions.',80)}<div class="field"><label>File audio nghe (.mp3, .wav, .m4a, .ogg, .webm · tối đa 30 MB)</label><div class="audio-upload"><input type="file" id="listeningUpload" accept="audio/*,.mp3,.m4a,.webm"/><span id="uploadLabel" class="tiny"></span></div>${draft.listening_audio?`<audio controls preload="metadata" src="/api/media/listening/${E(draft.listening_audio)}"></audio>`:''}</div>${questionBuilder('listening')}`;
  case 'reading':return `<h3>Nội dung Reading</h3>${textField('Hướng dẫn cho học sinh','reading_instructions','',80)}${textField('Reading passage','reading_passage','Dán toàn bộ bài đọc vào đây...',240)}${questionBuilder('reading')}`;
  case 'writing':return `<h3>Nội dung Writing</h3>${textField('Writing prompt / Đề bài','writing_prompt','Dán đề Writing do giáo viên tự biên soạn...',210)}<div class="field"><label>Số từ tối thiểu gợi ý (0 nếu không cần)</label><input class="input" type="number" min="0" max="1000" data-config="writing_min_words" value="${Number(draft.writing_min_words)}"/></div><div class="hint-box">Bài làm Writing được lưu dưới dạng văn bản để giáo viên đọc và chấm thủ công.</div>`;
  case 'speaking':return `<h3>Nội dung Speaking</h3>${textField('Câu hỏi / Speaking prompt','speaking_prompt','Nhập câu hỏi, hướng dẫn Speaking...',220)}<div class="field"><label>Thời gian chuẩn bị gợi ý (giây)</label><input class="input" type="number" data-config="speaking_preparation_seconds" min="0" max="180" value="${Number(draft.speaking_preparation_seconds)}"/></div><div class="hint-box">Học sinh tự ghi âm bằng microphone. Bản ghi được lưu tại máy chủ và chỉ admin được mở lại để chấm.</div>`;
}}
function bindEditor(){
  $$('[data-part]').forEach(el=>el.addEventListener('click',()=>{editPart=el.dataset.part;renderAdmin()}));
  $('#publishSwitch').addEventListener('change',e=>{draft.published=e.target.checked});
  $$('[data-config]').forEach(el=>el.addEventListener('input',()=>{draft[el.dataset.config]=el.type==='number'?Number(el.value):el.value}));
  const part=editPart;
  $$('[data-qfield]').forEach(el=>el.addEventListener(el.dataset.qfield==='type'?'change':'input',()=>{
    const q=draft[part+'_questions'][Number(el.dataset.qi)];q[el.dataset.qfield]=el.value;
    if(el.dataset.qfield==='type'){q.answer=el.value==='choice'?'A':'';q.options=['','','',''];renderAdmin()}
  }));
  $$('[data-opt]').forEach(el=>el.addEventListener('input',()=>{draft[part+'_questions'][Number(el.dataset.qi)].options[Number(el.dataset.opt)]=el.value}));
  $$('[data-deleteq]').forEach(el=>el.addEventListener('click',()=>{draft[part+'_questions'].splice(Number(el.dataset.deleteq),1);renderAdmin()}));
  $('#addQuestion')?.addEventListener('click',()=>{draft[part+'_questions'].push({id:crypto.randomUUID().replace(/-/g,'').slice(0,12),type:'choice',prompt:'',options:['','','',''],answer:'A'});renderAdmin();setTimeout(()=>$('.question-editor:last-of-type textarea')?.focus(),50)});
  $('#listeningUpload')?.addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;const status=$('#uploadLabel');status.textContent='Đang tải file...';const form=new FormData();form.append('file',file);try{const res=await api('/admin/listening-audio',{method:'POST',body:form});draft.listening_audio=res.filename;toast('Đã tải lên audio. Hãy lưu thay đổi để áp dụng.');renderAdmin()}catch(err){status.textContent=err.message;toast(err.message,true)}});
  $('#saveExam').addEventListener('click',async e=>{e.target.disabled=true;try{draft=await api('/admin/config',{method:'PUT',body:draft});toast('Đã lưu cấu hình bài thi thành công');renderAdmin()}catch(err){toast(err.message,true);e.target.disabled=false}});
}
function codesView(){return `<div class="admin-head"><div><span class="overline">EXAM ACCESS</span><h1 style="margin-top:8px">Mã dự thi</h1><p class="muted" style="margin:0">Mỗi mã chỉ dành cho một học sinh, dùng để đăng nhập và tiếp tục bài làm.</p></div></div><div class="codes-grid"><section class="card card-pad"><h3>Tạo mã mới</h3><p class="muted">Phát mã cho học sinh trước giờ kiểm tra.</p><div class="field"><label>Số mã cần tạo</label><select class="select" id="codeCount"><option value="1">1 mã</option><option value="5">5 mã</option><option value="10">10 mã</option><option value="20">20 mã</option></select></div><button class="btn full" id="createCodes">+ Tạo mã dự thi</button></section><section class="card"><div class="card-pad info-row"><div><h3 style="margin-bottom:5px">Danh sách mã</h3><span class="tiny">${codes.length} mã đã phát hành</span></div><button class="btn secondary sm" id="copyCodes">Sao chép mã chưa dùng</button></div>${codes.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Mã dự thi</th><th>Học sinh</th><th>Trạng thái</th></tr></thead><tbody>${codes.map(c=>`<tr><td class="code-text">${E(c.code)}</td><td>${E(c.name||'—')}</td><td>${c.name?'<span class="status">Đã dùng</span>':'<span class="status draft">Chưa dùng</span>'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Chưa có mã dự thi.</div>'}</section></div>`}
function bindCodes(){
  $('#createCodes').addEventListener('click',async e=>{e.target.disabled=true;try{const result=await api('/admin/codes',{method:'POST',body:{count:Number($('#codeCount').value)}});codes=await api('/admin/codes');renderAdmin();toast('Đã tạo '+result.codes.length+' mã mới.')}catch(err){toast(err.message,true);e.target.disabled=false}});
  $('#copyCodes').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(codes.filter(c=>!c.name).map(c=>c.code).join('\n'));toast('Đã sao chép danh sách mã chưa dùng.')}catch(err){toast('Không sao chép được. Hãy thử dùng HTTPS.',true)}});
}
function submissionsView(){return `<div class="admin-head"><div><span class="overline">STUDENT RESPONSES</span><h1 style="margin-top:8px">Bài nộp & chấm điểm</h1><p class="muted" style="margin:0">Câu hỏi khách quan được so đáp án; Writing và Speaking chấm thủ công.</p></div><div style="display:flex;gap:8px"><button class="btn secondary sm" id="refreshAttempts">Làm mới</button><a class="btn sm" href="/api/admin/export.csv" download>Xuất CSV ↓</a></div></div><div class="card">${attemptTable(attempts)}</div>`}
function bindAttempts(){
  $$('[data-attempt]').forEach(b=>b.addEventListener('click',async()=>{try{currentDetail=await api('/admin/attempts/'+encodeURIComponent(b.dataset.attempt));renderAdmin()}catch(err){toast(err.message,true)}}));
  $('#refreshAttempts')?.addEventListener('click',refreshAttempts);
  $('#refreshOverview')?.addEventListener('click',refreshAttempts);
}
async function refreshAttempts(){try{attempts=await api('/admin/attempts');renderAdmin();toast('Đã cập nhật danh sách.')}catch(err){toast(err.message,true)}}
function detailAnswers(part){const d=currentDetail,snap=d.exam_snapshot,qa=d.answers[part]||{};return (snap[part+'_questions']||[]).map((q,i)=>`<div class="detail-item"><div class="tiny">QUESTION ${i+1}</div><b>${E(q.prompt)}</b><p>Học sinh: <strong>${E(q.type==='choice'?`${qa[q.id]||'—'} — ${q.options?.['ABCD'.indexOf(qa[q.id])]||''}`:(qa[q.id]||'—'))}</strong></p><p class="tiny">Đáp án: ${E(q.answer)} ${q.type==='choice'?'— '+E(q.options?.['ABCD'.indexOf(q.answer)]||''):''}</p></div>`).join('')||'<div class="muted">Không có câu hỏi</div>'}
function renderDetail(){const d=currentDetail;app.innerHTML=header()+`<main class="shell page"><div style="max-width:960px;margin:auto"><button class="plainbtn" id="backDetails">← Quay lại danh sách</button><div class="admin-head" style="margin-top:15px"><div><span class="overline">CANDIDATE SUBMISSION</span><h1 style="margin-top:9px">${E(d.name)}</h1><p class="muted">Mã: <b>${E(d.code)}</b> · ${E(dateString(d.submitted_at||d.started_at))}</p></div>${statusBadge(d)}</div><div class="stats"><div class="stat"><p>Listening + Reading</p><strong>${d.objective.correct}/${d.objective.total}</strong></div><div class="stat"><p>Writing (admin)</p><strong>${d.writing_score??'—'}</strong></div><div class="stat"><p>Speaking (admin)</p><strong>${d.speaking_score??'—'}</strong></div></div><div class="card card-pad"><h3>01 · Listening</h3><div class="detail-list">${detailAnswers('listening')}</div><hr class="rule"/><h3>02 · Reading</h3><div class="detail-list">${detailAnswers('reading')}</div><hr class="rule"/><h3>03 · Writing</h3><div class="detail-item"><p>${E(d.answers.writing||'Chưa có câu trả lời')}</p></div><hr class="rule"/><h3>04 · Speaking</h3>${d.speaking_recorded?`<audio controls style="width:100%;max-width:500px" src="/api/media/speaking/${E(d.id)}"></audio>`:'<div class="hint-box">Chưa có bản ghi Speaking.</div>'}<hr class="rule"/><h3>Đánh giá của giáo viên</h3><form id="gradeForm"><div class="detail-grid"><div class="field"><label>Writing score (0–9)</label><input class="input" id="writingScore" type="number" min="0" max="9" step="0.5" value="${E(d.writing_score??'')}" placeholder="Chưa chấm"/></div><div class="field"><label>Speaking score (0–9)</label><input class="input" id="speakingScore" type="number" min="0" max="9" step="0.5" value="${E(d.speaking_score??'')}" placeholder="Chưa chấm"/></div></div><div class="field"><label>Nhận xét / Ghi chú nội bộ</label><textarea class="textarea" id="gradingFeedback" placeholder="Nhận xét của giáo viên...">${E(d.feedback||'')}</textarea></div><button class="btn" type="submit">Lưu đánh giá</button></form></div></div></main>`;
  bindHeader();$('#backDetails').addEventListener('click',()=>{currentDetail=null;adminTab='submissions';renderAdmin()});
  $('#gradeForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/admin/attempts/'+encodeURIComponent(d.id)+'/grade',{method:'PUT',body:{writing_score:$('#writingScore').value||null,speaking_score:$('#speakingScore').value||null,feedback:$('#gradingFeedback').value}});currentDetail=await api('/admin/attempts/'+encodeURIComponent(d.id));attempts=await api('/admin/attempts');renderDetail();toast('Đã lưu điểm và nhận xét.')}catch(err){toast(err.message,true)}});
}
init();
