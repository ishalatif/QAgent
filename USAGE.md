# Panduan Penggunaan QAgent

QAgent adalah CLI untuk menjalankan pemeriksaan QA otomatis pada aplikasi web melalui URL atau folder source code. File ini berisi cara memakai project.

## Kebutuhan

- Node.js `24` atau lebih baru
- npm
- Chromium untuk Playwright

## Instalasi

Clone repository:

```bash
git clone https://github.com/ishalatif/QAgent.git
cd QAgent
```

Install dependency:

```bash
npm install
```

Install browser Playwright:

```bash
npx playwright install chromium
```

Build project:

```bash
npm run build
```

Cek environment lokal:

```bash
npm run qagent -- doctor
```

## Membuat Konfigurasi

Buat file konfigurasi awal:

```bash
npm run qagent -- init
```

Perintah ini membuat file:

```text
qa.config.yaml
```

Contoh konfigurasi sederhana:

```yaml
project:
  name: my-web-app

target:
  environment: local
  url: http://localhost:3000
  allowed_hosts:
    - localhost

safety:
  destructive: false
  active_security_scan: false
  load_test: false
  max_concurrency: 3
  allow_source_commands: false

tests:
  layers: [browser, accessibility, performance, security]

report:
  formats: [html, json, junit, xlsx]
  evidence_on: failure
```

Sesuaikan `target.url`, `allowed_hosts`, dan `tests.layers` dengan aplikasi yang ingin diuji.

## Menjalankan QA dari URL

Gunakan mode URL jika aplikasi sudah berjalan di browser:

```bash
npm run qagent -- run --url http://localhost:3000
```

Menggunakan file konfigurasi:

```bash
npm run qagent -- run --url http://localhost:3000 --config qa.config.yaml
```

Output akan dibuat di:

```text
.qagent/runs/<run-id>/
```

## Menjalankan QA dari Folder Source

Gunakan mode source jika ingin QAgent membaca folder project:

```bash
npm run qagent -- run .
```

Secara default, mode source hanya melakukan inspeksi. Untuk mengizinkan command aman seperti lint, typecheck, test, atau build:

```bash
npm run qagent -- run . --allow-source-commands
```

Atau aktifkan dari konfigurasi:

```yaml
safety:
  allow_source_commands: true
```

## Memilih Layer Test

Layer yang tersedia:

- `browser`
- `api`
- `authorization`
- `accessibility`
- `performance`
- `security`
- `load`

Jalankan layer tertentu:

```bash
npm run qagent -- run --url http://localhost:3000 --layers accessibility
```

Jalankan beberapa layer:

```bash
npm run qagent -- run --url http://localhost:3000 --layers browser,accessibility,security
```

Load smoke membutuhkan izin eksplisit:

```yaml
safety:
  load_test: true
```

Contoh:

```bash
npm run qagent -- run --url http://localhost:3000 --layers load
```

## Auth Profile

Jika aplikasi membutuhkan login, simpan credential di environment variable, bukan langsung di file konfigurasi.

Contoh konfigurasi:

```yaml
auth:
  profiles:
    admin:
      loginUrl: /login
      credentials:
        username: ${ADMIN_EMAIL}
        password: ${ADMIN_PASSWORD}
      selectors:
        username: '[name="email"]'
        password: '[name="password"]'
        submit: 'button[type="submit"]'
      success:
        urlContains: /dashboard
```

PowerShell:

```powershell
$env:ADMIN_EMAIL="admin@example.com"
$env:ADMIN_PASSWORD="password"
npm run qagent -- run --url http://localhost:3000 --profile admin
```

Bash:

```bash
ADMIN_EMAIL="admin@example.com" ADMIN_PASSWORD="password" npm run qagent -- run --url http://localhost:3000 --profile admin
```

## API Check

Tambahkan assertion API di `qa.config.yaml`:

```yaml
api:
  assertions:
    - key: health
      method: GET
      path: /health
      expected_status: 200

tests:
  layers: [api]
```

Jalankan:

```bash
npm run qagent -- run --url http://localhost:3000 --layers api
```

## Authorization Check

Contoh konfigurasi pengecekan akses role:

```yaml
api:
  authorization:
    - permission: manage_users
      method: GET
      path: /admin/users
      allow: [admin]
      deny: [learner]
      deny_status: [401, 403]

tests:
  layers: [authorization]
```

Jalankan:

```bash
npm run qagent -- run --url http://localhost:3000 --layers authorization
```

## Melihat Report

Setiap run menghasilkan:

```text
.qagent/runs/<run-id>/report.html
.qagent/runs/<run-id>/report.json
.qagent/runs/<run-id>/junit.xml
.qagent/runs/<run-id>/report.xlsx
```

Lihat lokasi report berdasarkan `RUN_ID`:

```bash
npm run qagent -- report open RUN_ID
```

Buka report HTML di browser:

```bash
npm run qagent -- report open RUN_ID --browser
```

## Dashboard Lokal

Jalankan dashboard:

```bash
npm run qagent -- dashboard
```

Buka:

```text
http://127.0.0.1:4810
```

Aktifkan trigger run dari dashboard:

```bash
npm run qagent -- dashboard --allow-run-trigger
```

Contoh trigger dari PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4810/api/v1/runs -ContentType 'application/json' -Body '{"url":"http://127.0.0.1:3000","layers":["security"]}'
```

## Baseline dan Compare

Buat baseline dari run yang sudah selesai:

```bash
npm run qagent -- baseline create --run RUN_ID --name stable
```

Bandingkan run baru dengan baseline:

```bash
npm run qagent -- compare --run RUN_ID --baseline stable
```

## Daftar Browser Test

Lihat test browser yang tersedia:

```bash
npm run qagent -- tests
```

Filter berdasarkan tag:

```bash
npm run qagent -- tests --tag smoke
```

Filter berdasarkan test key:

```bash
npm run qagent -- tests --test auth-login
```

## Daftar Adapter

Lihat adapter yang tersedia:

```bash
npm run qagent -- adapters list
```

Cek adapter berdasarkan folder source:

```bash
npm run qagent -- adapters list --source .
```

## Cek Instalasi

Typecheck:

```bash
npm run check
```

Unit test:

```bash
npm run test:unit
```

Integration test:

```bash
npm run test:integration
```

Full test:

```bash
npm test
```

## Exit Code

- `0`: QA passed
- `1`: quality gate failed
- `2`: configuration error
- `3`: runner/internal error
- `4`: unsafe operation
- `130`: cancelled
