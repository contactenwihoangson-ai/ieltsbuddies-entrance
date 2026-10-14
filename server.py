"""IELTS Buddies entrance assessment. FastAPI + SQLite, teacher-authored exams."""
import csv
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

ROOT = Path(__file__).parent
DATA_DIR = Path(os.environ.get('DATA_DIR', str(ROOT / 'data')))
UPLOAD_DIR = DATA_DIR / 'uploads'
DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DB = DATA_DIR / 'exam.sqlite3'
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', '')
SECRET = os.environ.get('SECRET_KEY', '')
if not ADMIN_PASSWORD or not SECRET:
    raise RuntimeError('Set ADMIN_PASSWORD and SECRET_KEY environment variables. See README.md.')
signer = URLSafeTimedSerializer(SECRET, salt='ielts-buddies-sessions-v1')
app = FastAPI(title='IELTS Buddies Entrance Test', docs_url=None, redoc_url=None)

DEFAULT_EXAM = {
    'title': 'IELTS Entrance Assessment',
    'duration_minutes': 60,
    'published': False,
    'listening_instructions': 'Listen carefully to the recording and answer the questions below.',
    'listening_audio': None,
    'listening_questions': [],
    'reading_instructions': 'Read the passage and answer the questions below.',
    'reading_passage': '',
    'reading_questions': [],
    'writing_prompt': '',
    'writing_min_words': 0,
    'speaking_prompt': '',
    'speaking_preparation_seconds': 30,
}
STAGES = ('listening', 'reading', 'writing', 'speaking')

@contextmanager
def db():
    conn = sqlite3.connect(DB, timeout=20)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()

with db() as conn:
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('''CREATE TABLE IF NOT EXISTS exam (id INTEGER PRIMARY KEY, data TEXT NOT NULL)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS codes (
        code TEXT PRIMARY KEY, name TEXT, created_at INTEGER NOT NULL)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        started_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
        stage_index INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'in_progress',
        submitted_at INTEGER, exam_snapshot TEXT NOT NULL, answers TEXT NOT NULL DEFAULT '{}',
        speaking_path TEXT, speaking_mime TEXT,
        writing_score REAL, speaking_score REAL, feedback TEXT NOT NULL DEFAULT '')''')
    if not conn.execute('SELECT 1 FROM exam WHERE id=1').fetchone():
        conn.execute('INSERT INTO exam (id,data) VALUES (1,?)', (json.dumps(DEFAULT_EXAM),))


def get_exam(conn):
    return json.loads(conn.execute('SELECT data FROM exam WHERE id=1').fetchone()['data'])


def set_cookie(resp: Response, kind: str, identifier: str, request: Request):
    token = signer.dumps({'role':kind, 'id':identifier})
    resp.set_cookie('ib_session', token, httponly=True, samesite='lax',
                    secure=request.url.scheme == 'https', max_age=86400*7, path='/')


def get_session(request: Request):
    raw = request.cookies.get('ib_session')
    if not raw:
        return None
    try:
        return signer.loads(raw, max_age=86400*7)
    except (BadSignature, SignatureExpired):
        return None


def admin_auth(request: Request):
    s = get_session(request)
    if not s or s.get('role') != 'admin':
        raise HTTPException(401, 'Administrator login required')


def student_auth(request: Request):
    s = get_session(request)
    if not s or s.get('role') != 'student':
        raise HTTPException(401, 'Student login required')
    with db() as conn:
        sync_expired(conn)
        row = conn.execute('SELECT * FROM attempts WHERE id=?', (s['id'],)).fetchone()
        if not row:
            raise HTTPException(401, 'Session not found')
        return dict(row)


def sync_expired(conn):
    now = int(time.time())
    conn.execute('''UPDATE attempts SET status='submitted', submitted_at=deadline_at
                    WHERE status='in_progress' AND deadline_at<=?''', (now,))


def clean_text(value, max_len=20000):
    return str(value or '').strip()[:max_len]


def normalize_question(q):
    kind = q.get('type', 'choice')
    if kind not in ('choice','short'):
        raise HTTPException(400, 'Unsupported question type')
    return {'id': clean_text(q.get('id'), 80) or uuid.uuid4().hex[:10],
            'type':kind, 'prompt':clean_text(q.get('prompt'), 1500),
            'options':[clean_text(c,500) for c in q.get('options', [])][:8] if kind=='choice' else [],
            'answer':clean_text(q.get('answer'),1000)}


def student_exam(exam):
    safe = {k:v for k,v in exam.items() if k != 'published'}
    for section in ('listening_questions', 'reading_questions'):
        safe[section] = [{k:v for k,v in q.items() if k != 'answer'} for q in exam[section]]
    return safe


def correct_answer(answer, expected):
    norm = lambda x: re.sub(r'\s+', ' ', str(x or '').strip().casefold())
    return bool(norm(answer)) and norm(answer) in [norm(x) for x in expected.split('|')]


def objective_score(attempt):
    snap = json.loads(attempt['exam_snapshot'])
    ans = json.loads(attempt['answers'])
    good = total = 0
    for stage in ('listening','reading'):
        for q in snap[stage+'_questions']:
            total += 1
            if correct_answer(ans.get(stage,{}).get(q['id'],''), q['answer']):
                good += 1
    return {'correct':good,'total':total}


def attempt_public(row, include_private=False):
    a = dict(row)
    obj = objective_score(a)
    response = {'id':a['id'],'code':a['code'],'name':a['name'],
                'status':a['status'],'stage_index':a['stage_index'],
                'started_at':a['started_at'],'submitted_at':a['submitted_at'],
                'objective':obj, 'writing_score':a['writing_score'],
                'speaking_score':a['speaking_score']}
    if include_private:
        response.update({'answers':json.loads(a['answers']),
                         'exam_snapshot':json.loads(a['exam_snapshot']),
                         'speaking_recorded':bool(a['speaking_path']),
                         'feedback':a['feedback']})
    return response


@app.get('/api/session')
def session(request: Request):
    s = get_session(request)
    if not s:
        return {'role':'guest'}
    if s.get('role') == 'admin':
        return {'role':'admin'}
    if s.get('role') == 'student':
        with db() as conn:
            sync_expired(conn)
            row = conn.execute('SELECT status FROM attempts WHERE id=?', (s['id'],)).fetchone()
            if row:
                return {'role':'student','status':row['status']}
    return {'role':'guest'}


@app.post('/api/admin/login')
async def admin_login(request: Request, response: Response):
    data = await request.json()
    if not hmac.compare_digest(str(data.get('password','')).encode(), ADMIN_PASSWORD.encode()):
        raise HTTPException(401, 'Mật khẩu không chính xác')
    set_cookie(response, 'admin', 'admin', request)
    return {'ok':True}


@app.post('/api/logout')
def logout(response: Response):
    response.delete_cookie('ib_session', path='/')
    return {'ok':True}


@app.get('/api/admin/config')
def admin_config(request: Request):
    admin_auth(request)
    with db() as conn:
        return get_exam(conn)


@app.put('/api/admin/config')
async def save_config(request: Request):
    admin_auth(request)
    payload = await request.json()
    exam = dict(DEFAULT_EXAM)
    exam['title'] = clean_text(payload.get('title'),120) or DEFAULT_EXAM['title']
    exam['published'] = bool(payload.get('published',False))
    exam['duration_minutes'] = max(5,min(240,int(payload.get('duration_minutes') or 60)))
    for field in ('listening_instructions','reading_instructions','reading_passage',
                  'writing_prompt','speaking_prompt'):
        exam[field] = clean_text(payload.get(field),40000)
    exam['writing_min_words'] = max(0,min(1000,int(payload.get('writing_min_words') or 0)))
    exam['speaking_preparation_seconds'] = max(0,min(180,int(payload.get('speaking_preparation_seconds') or 0)))
    audio = payload.get('listening_audio')
    if audio and re.fullmatch(r'[a-f0-9]{32}\.(mp3|wav|ogg|m4a|webm)',str(audio)) and (UPLOAD_DIR/audio).exists():
        exam['listening_audio'] = audio
    for part in ('listening_questions','reading_questions'):
        exam[part] = [normalize_question(q) for q in payload.get(part,[])][:100]
    ids = [q['id'] for part in ('listening_questions','reading_questions') for q in exam[part]]
    if len(ids) != len(set(ids)):
        raise HTTPException(400, 'Question IDs must be unique')
    if exam['published']:
        missing = []
        if not exam['listening_audio'] or not exam['listening_questions']:
            missing.append('Listening (audio và câu hỏi)')
        if not exam['reading_passage'] or not exam['reading_questions']:
            missing.append('Reading (bài đọc và câu hỏi)')
        if not exam['writing_prompt']:
            missing.append('Writing')
        if not exam['speaking_prompt']:
            missing.append('Speaking')
        if any(not q['prompt'] or not q['answer'] or
               (q['type']=='choice' and (len([o for o in q['options'] if o]) < 2 or
                  q['answer'] not in 'ABCDEFGH'[:len(q['options'])] or
                  not q['options']['ABCDEFGH'.index(q['answer'])]))
               for part in ('listening_questions','reading_questions') for q in exam[part]):
            missing.append('Nội dung, đáp án và lựa chọn câu hỏi')
        if missing:
            raise HTTPException(400, 'Chưa thể xuất bản: ' + ', '.join(missing))
    with db() as conn:
        conn.execute('UPDATE exam SET data=? WHERE id=1', (json.dumps(exam,ensure_ascii=False),))
    return exam


async def save_media(file: UploadFile, extensions, max_mb):
    name = file.filename or ''
    ext = Path(name).suffix.lower().removeprefix('.')
    if ext not in extensions:
        raise HTTPException(400, 'Định dạng tệp không hỗ trợ: '+name)
    key = uuid.uuid4().hex+'.'+ext
    target = UPLOAD_DIR/key
    bytes_total = 0
    try:
        with target.open('wb') as dest:
            while chunk := await file.read(1024*1024):
                bytes_total += len(chunk)
                if bytes_total > max_mb*1024*1024:
                    raise HTTPException(413,'Tệp quá lớn')
                dest.write(chunk)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    if bytes_total == 0:
        target.unlink(missing_ok=True)
        raise HTTPException(400,'Tệp trống')
    return key


@app.post('/api/admin/listening-audio')
async def upload_listening(request: Request, file: UploadFile = File(...)):
    admin_auth(request)
    key = await save_media(file, {'mp3','wav','ogg','m4a','webm'},30)
    return {'filename':key}


@app.get('/api/media/listening/{filename}')
def media_listening(filename: str, request: Request):
    if not re.fullmatch(r'[a-f0-9]{32}\.(mp3|wav|ogg|m4a|webm)',filename):
        raise HTTPException(404)
    s = get_session(request)
    allowed = False
    if s and s.get('role') == 'admin':
        allowed = True
    elif s and s.get('role') == 'student':
        with db() as conn:
            row = conn.execute('SELECT exam_snapshot FROM attempts WHERE id=?',(s['id'],)).fetchone()
            if row:
                allowed = json.loads(row['exam_snapshot']).get('listening_audio') == filename
    if not allowed:
        raise HTTPException(403)
    file = UPLOAD_DIR/filename
    if not file.is_file():
        raise HTTPException(404)
    return FileResponse(file)


@app.post('/api/admin/codes')
async def create_codes(request: Request):
    admin_auth(request)
    data = await request.json()
    count = max(1,min(int(data.get('count',1)),50))
    new_codes = []
    with db() as conn:
        for _ in range(count):
            for _attempt in range(5):
                code = secrets.token_hex(4).upper()
                try:
                    conn.execute('INSERT INTO codes (code,created_at) VALUES (?,?)',(code,int(time.time())))
                    new_codes.append(code)
                    break
                except sqlite3.IntegrityError:
                    continue
    return {'codes':new_codes}


@app.get('/api/admin/codes')
def list_codes(request: Request):
    admin_auth(request)
    with db() as conn:
        return [dict(x) for x in conn.execute('SELECT * FROM codes ORDER BY created_at DESC,code DESC')]


@app.post('/api/student/login')
async def student_login(request: Request, response: Response):
    data = await request.json()
    code = re.sub(r'\s+','',str(data.get('code',''))).upper()
    name = re.sub(r'\s+',' ',clean_text(data.get('name'),100)).strip()
    if not code or not name or len(name)<2:
        raise HTTPException(400,'Nhập mã dự thi và họ tên hợp lệ')
    with db() as conn:
        sync_expired(conn)
        exam = get_exam(conn)
        code_rec = conn.execute('SELECT * FROM codes WHERE code=?',(code,)).fetchone()
        if not code_rec:
            raise HTTPException(403,'Mã dự thi không hợp lệ. Vui lòng liên hệ giáo viên.')
        row = conn.execute('SELECT * FROM attempts WHERE code=?',(code,)).fetchone()
        if row:
            if row['name'].casefold() != name.casefold():
                raise HTTPException(403,'Mã này đã được sử dụng với họ tên khác.')
            attempt_id = row['id']
        else:
            if not exam['published']:
                raise HTTPException(403,'Bài thi chưa được giáo viên mở.')
            now = int(time.time())
            attempt_id = uuid.uuid4().hex
            conn.execute('''INSERT INTO attempts
                            (id,code,name,started_at,deadline_at,exam_snapshot)
                            VALUES (?,?,?,?,?,?)''',
                         (attempt_id,code,name,now,now+60*exam['duration_minutes'],
                          json.dumps(exam,ensure_ascii=False)))
            conn.execute('UPDATE codes SET name=? WHERE code=?',(name,code))
    set_cookie(response,'student',attempt_id,request)
    return {'ok':True}


@app.get('/api/student/state')
def student_state(request: Request):
    a = student_auth(request)
    return {'name':a['name'], 'code':a['code'], 'status':a['status'],
            'stage_index':a['stage_index'], 'deadline_at':a['deadline_at'],
            'server_time':int(time.time()), 'exam':student_exam(json.loads(a['exam_snapshot'])),
            'answers':json.loads(a['answers']), 'speaking_recorded':bool(a['speaking_path'])}


@app.put('/api/student/answers')
async def student_answers(request: Request):
    a = student_auth(request)
    payload = await request.json()
    stage = payload.get('stage')
    if a['status'] != 'in_progress':
        raise HTTPException(409,'Bài thi đã nộp hoặc hết giờ')
    if stage not in STAGES or STAGES.index(stage) != a['stage_index']:
        raise HTTPException(409,'Không thể sửa phần đã hoàn tất')
    answers = json.loads(a['answers'])
    if stage in ('listening','reading'):
        valid_ids = {q['id'] for q in json.loads(a['exam_snapshot'])[stage+'_questions']}
        updates = payload.get('answers',{})
        answers[stage] = {k:clean_text(v,1000) for k,v in updates.items() if k in valid_ids}
    elif stage == 'writing':
        answers['writing'] = clean_text(payload.get('text'),50000)
    else:
        raise HTTPException(400,'Speaking dùng ghi âm')
    with db() as conn:
        conn.execute('UPDATE attempts SET answers=? WHERE id=?',(json.dumps(answers,ensure_ascii=False),a['id']))
    return {'saved':True}


@app.post('/api/student/speaking')
async def upload_speaking(request: Request, file: UploadFile = File(...)):
    a = student_auth(request)
    if a['status']!='in_progress' or a['stage_index'] != 3:
        raise HTTPException(409,'Không thể tải ghi âm ở phần này')
    key = await save_media(file, {'webm','mp4','ogg','wav','mp3','m4a'},100)
    with db() as conn:
        conn.execute('UPDATE attempts SET speaking_path=?,speaking_mime=? WHERE id=?',
                     (key,file.content_type or 'audio/webm',a['id']))
    if a['speaking_path']:
        (UPLOAD_DIR/a['speaking_path']).unlink(missing_ok=True)
    return {'recorded':True}


@app.post('/api/student/advance')
def advance(request: Request):
    a = student_auth(request)
    if a['status']!='in_progress':
        raise HTTPException(409,'Bài thi đã nộp hoặc hết giờ')
    with db() as conn:
        if a['stage_index'] < 3:
            conn.execute('UPDATE attempts SET stage_index=stage_index+1 WHERE id=?',(a['id'],))
        else:
            if not a['speaking_path']:
                raise HTTPException(400,'Bạn cần ghi âm Speaking trước khi nộp bài.')
            conn.execute('UPDATE attempts SET status=?,submitted_at=? WHERE id=?',
                         ('submitted',int(time.time()),a['id']))
    return {'ok':True}


@app.get('/api/media/speaking/self')
def media_own_speaking(request: Request):
    a = student_auth(request)
    if not a['speaking_path']:
        raise HTTPException(404, 'Chưa có ghi âm')
    return FileResponse(UPLOAD_DIR / a['speaking_path'],
                        media_type=a['speaking_mime'] or 'audio/webm')


@app.get('/api/admin/attempts')
def attempts(request: Request):
    admin_auth(request)
    with db() as conn:
        sync_expired(conn)
        return [attempt_public(r) for r in conn.execute('SELECT * FROM attempts ORDER BY started_at DESC')]


@app.get('/api/admin/attempts/{attempt_id}')
def attempt_detail(attempt_id: str,request: Request):
    admin_auth(request)
    with db() as conn:
        sync_expired(conn)
        row=conn.execute('SELECT * FROM attempts WHERE id=?',(attempt_id,)).fetchone()
        if not row:
            raise HTTPException(404,'Không có bài thi')
        return attempt_public(row,True)


@app.put('/api/admin/attempts/{attempt_id}/grade')
async def grade_attempt(attempt_id: str,request: Request):
    admin_auth(request)
    data = await request.json()
    def score(key):
        val = data.get(key)
        if val is None or val=='':
            return None
        try:
            val=float(val)
        except (TypeError,ValueError):
            raise HTTPException(400,'Điểm phải là số')
        if not 0<=val<=9:
            raise HTTPException(400,'Điểm phải từ 0 đến 9')
        return val
    with db() as conn:
        result=conn.execute('''UPDATE attempts SET writing_score=?,speaking_score=?,feedback=?
                                WHERE id=?''',
              (score('writing_score'),score('speaking_score'),clean_text(data.get('feedback'),5000),attempt_id))
        if not result.rowcount:
            raise HTTPException(404)
    return {'saved':True}


@app.get('/api/media/speaking/{attempt_id}')
def media_speaking(attempt_id: str,request: Request):
    admin_auth(request)
    with db() as conn:
        row=conn.execute('SELECT speaking_path,speaking_mime FROM attempts WHERE id=?',(attempt_id,)).fetchone()
    if not row or not row['speaking_path']:
        raise HTTPException(404)
    return FileResponse(UPLOAD_DIR/row['speaking_path'],media_type=row['speaking_mime'])


@app.get('/api/admin/export.csv')
def export_csv(request: Request):
    admin_auth(request)
    with db() as conn:
        sync_expired(conn)
        rows=[attempt_public(r) for r in conn.execute('SELECT * FROM attempts ORDER BY started_at DESC')]
    file=io.StringIO()
    writer=csv.writer(file)
    writer.writerow(['Mã dự thi','Họ tên','Trạng thái','Listening/Reading đúng',
                     'Số câu khách quan','Writing','Speaking','Submitted timestamp'])
    for row in rows:
        writer.writerow([row['code'],row['name'],row['status'],row['objective']['correct'],
                         row['objective']['total'],row['writing_score'],row['speaking_score'],row['submitted_at']])
    file.seek(0)
    return StreamingResponse(iter([file.getvalue().encode('utf-8-sig')]),
        media_type='text/csv', headers={'Content-Disposition':'attachment; filename="entrance-results.csv"'})

app.mount('/static',StaticFiles(directory=ROOT/'static'),name='static')

@app.get('/')
def index():
    return FileResponse(ROOT/'static'/'index.html')

if __name__=='__main__':
    import uvicorn
    uvicorn.run(app,host='0.0.0.0',port=int(os.environ.get('PORT','8000')))
