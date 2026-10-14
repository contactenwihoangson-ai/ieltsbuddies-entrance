# IELTS Buddies — Entrance Assessment

A lightweight web app for teacher-created, four-skill English entrance tests. Font: Roboto. Interface: Vietnamese admin + streamlined IELTS-inspired English test screens.

## Features

- **Students:** enter assigned candidate code and full name; complete Listening → Reading → Writing → Speaking; autosave objective and written responses; record and review Speaking audio; submit once; see *no scores*.
- **Admins:** sign in with server-side password; manually enter **all** assessment prompts, audio, reading passage, MCQs and short-answer keys; issue candidate codes; publish/unpublish; review full submissions and Speaking recordings; mark Writing/Speaking; export results as CSV.
- **Database:** SQLite, stored on the server (`data/exam.sqlite3`), plus private audio files under `data/uploads/`. Candidate session cookies are HTTP-only and signed. Existing student attempts preserve an exam snapshot if an admin later edits the live exam.
- **Timing:** whole-test duration controlled by the server, beginning at first sign-in. Candidates proceed through skills in strict order; they cannot revisit previously completed sections.

## Start locally (Python 3.10+)

```bash
cd ielts-buddies-entrance-test
python -m pip install -r requirements.txt
export ADMIN_PASSWORD='USE-YOUR-OWN-STRONG-PASSWORD'
export SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"
python server.py
```

Open `http://localhost:8000` in your browser. Select **Dành cho quản trị viên** to sign in and set up your own exam. For Windows PowerShell use `$env:ADMIN_PASSWORD="..."` and `$env:SECRET_KEY="..."` instead of `export`.

**Important:** The exam starts with *no preset questions*. Admin must enter the content and listening recording, save, and toggle **Xuất bản đề**. Create unique codes in **Mã dự thi** and share one code per student.

## Run as a website for real students

Deploy the entire application to a Python-capable service (VPS, Render, Railway or another host) with persistent disk storage. Set environment variables:

- `ADMIN_PASSWORD`: a long, private admin password.
- `SECRET_KEY`: a fixed, randomly generated string (do not regenerate on every startup).
- `DATA_DIR`: an **attached persistent volume**, not an ephemeral deployment directory.
- `PORT`: server port (defaults to `8000`).

Use **HTTPS**. Browsers generally permit microphone access only on HTTPS (or localhost). Make sure storage persists over redeploys, and back up the `DATA_DIR` folder. Limit who knows candidate access codes.

Example Docker build/run:

```bash
docker build -t buddies-entrance .
docker run -p 8000:8000 -v buddies-data:/app/data \
  -e ADMIN_PASSWORD='CHOOSE-A-STRONG-PASSWORD' \
  -e SECRET_KEY='USE-A-LONG-STABLE-RANDOM-KEY' \
  buddies-entrance
```

## Security / practical notes

- **Do not deploy** with the placeholder secrets in `.env.example`. There is no hard-coded admin password.
- Candidate code acts as the student's secret access credential; the student's name is recorded at first sign-in. For high-stakes testing, add formal identity verification, individual time windows, and an anti-cheating policy.
- Listening/Reading use exact-match grading after trimming whitespace and case-folding. Enter multiple accepted short answers separated by `|` (for example `child | children`). MCQ answers are selected as `A`, `B`, `C`, `D`.
- Writing/Speaking are **never automatically evaluated**; scores and comments remain in the private admin dashboard.
- This is a deployable working application, **not a hosted public URL**. Admin must deploy it before different students can access it remotely.
- This compact application is suitable for small classes. Before high-volume public deployment, add rate limiting and managed storage/database, administrator 2FA, automated backups, and an explicit student privacy/recording notice.
