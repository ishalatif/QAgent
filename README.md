# QAgent

QAgent adalah runner QA otomatis berbasis CLI untuk menguji aplikasi web dari URL atau folder source code. Produk ini dirancang agar stabil, deterministik, aman untuk target, ringan dijalankan lokal, serta mudah masuk ke pipeline CI.


## Mulai Cepat

```bash
npm install
npx playwright install chromium
npm run build
npm run qagent -- init
npm run qagent -- doctor
npm run qagent -- adapters list
```

Menjalankan target URL:

```bash
npm run qagent -- run --url http://localhost:3000
```

Menjalankan layer tertentu:

```bash
npm run qagent -- run --url http://localhost:3000 --layers accessibility
npm run qagent -- run --url http://localhost:3000 --layers performance
npm run qagent -- run --url http://localhost:3000 --layers security
```

Menjalankan Source Mode:

```bash
npm run qagent -- run .
npm run qagent -- run . --allow-source-commands
npm run qagent -- adapters list --source .
```

Regression baseline:

```bash
npm run qagent -- baseline create --run RUN_ID --name stable
npm run qagent -- compare --run RUN_ID --baseline stable
```

Membuka atau mencari lokasi report:

```bash
npm run qagent -- report open RUN_ID
npm run qagent -- report open RUN_ID --browser
```

Dashboard lokal:

```bash
npm run qagent -- dashboard
npm run qagent -- dashboard --allow-run-trigger
```

Validasi project:

```bash
npm run test:security
npm run test:compatibility
npm run release:check
```

## Output

Setiap run menulis artifact ke:

```text
.qagent/runs/<run-id>/
```

Isi utama folder run:

- `report.json`
- `report.html`
- `junit.xml`
- `report.xlsx`
- folder `evidence/` jika ada evidence yang perlu disimpan

Comparison regression ditulis ke:

```text
.qagent/comparisons/<comparison-id>/
```

Perintah `qagent report open RUN_ID` membaca metadata dari SQLite dan menampilkan path report yang sudah dibuat. Tambahkan `--browser` hanya jika ingin membuka HTML report dengan browser default.

## Cloud Mode

Cloud Mode digunakan saat target berupa URL:

```bash
npm run qagent -- run --url http://localhost:3000
```

Mode ini tidak bergantung pada bahasa/framework target. QAgent berinteraksi lewat browser dan HTTP, lalu mengumpulkan halaman, status, judul, link, form, button, console error, network failure, redirect, dan endpoint HTTP/API yang teramati.

Layer Cloud Mode dapat dipilih melalui `tests.layers` di config atau flag CLI `--layers`.

## Source Mode

Source Mode digunakan saat target berupa folder:

```bash
npm run qagent -- run .
```

Secara default Source Mode bersifat inspection-only. QAgent membaca marker project, memilih runtime adapter, menampilkan capability, dan tidak menjalankan command source kecuali diizinkan lewat:

```bash
--allow-source-commands
```

atau:

```yaml
safety:
  allow_source_commands: true
```

Runtime yang sudah didukung:

- Node.js / TypeScript
- Python
- Generic adapter berbasis command eksplisit

Runtime yang sudah dikenali tetapi masih planned:

- PHP
- Java
- .NET
- Go

## Auth Profile

Credential harus memakai environment variable, bukan literal credential di config.

Contoh:

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

QAgent menyimpan browser session untuk kebutuhan test, tetapi tidak menyimpan password/token mentah ke report.

## API dan RBAC

API/RBAC berjalan saat `tests.layers` berisi `api` atau `authorization`.

Contoh ringkas:

```yaml
api:
  assertions:
    - key: health
      method: GET
      path: /health
      expected_status: 200
  authorization:
    - permission: manage_users
      method: GET
      path: /admin/users
      allow: [admin]
      deny: [learner]
      deny_status: [401, 403]
```

Jika role yang seharusnya ditolak mendapat response 2xx, QAgent membuat finding `authorization-bypass`.

## Accessibility

Accessibility berjalan saat layer `accessibility` dipilih.

Adapter:

```text
axe-accessibility
```

Engine:

```text
axe-core
```

Contoh:

```bash
npm run qagent -- run --url http://localhost:3000 --layers accessibility
```

Adapter ini memindai halaman public dari `accessibility.include` atau halaman same-origin hasil discovery. Authenticated accessibility juga bisa memakai profile yang dikonfigurasi di `accessibility.profiles`.

Default gate gagal hanya untuk violation `critical` dan `serious`.

Evidence ditulis ke:

```text
.qagent/runs/<run-id>/evidence/accessibility/
```

## Performance

Performance berjalan saat layer `performance` dipilih.

Adapter:

```text
browser-performance
```

Engine:

```text
browser-timing
```

Contoh:

```bash
npm run qagent -- run --url http://localhost:3000 --layers performance
```

Adapter ini membaca Navigation Timing dan Resource Timing dari browser. Threshold default meliputi:

- first byte
- DOM content loaded
- load event
- transfer size
- jumlah resource

Evidence ditulis ke:

```text
.qagent/runs/<run-id>/evidence/performance/
```

Catatan: ini adalah performance timing ringan. Audit Lighthouse penuh masih menjadi future external adapter.

## Security Passive

Security pasif berjalan saat layer `security` dipilih.

Adapter:

```text
passive-security
```

Engine:

```text
passive-http
```

Contoh:

```bash
npm run qagent -- run --url http://localhost:3000 --layers security
```

Check yang didukung:

- `content-security-policy`
- `frame-protection`
- `x-content-type-options`
- `referrer-policy`
- `strict-transport-security`
- `cookie-http-only`
- `cookie-secure`
- `cookie-same-site`

Adapter ini tidak melakukan active scan, fuzzing, atau mutasi data. Evidence tidak menyimpan nilai cookie mentah.

Evidence ditulis ke:

```text
.qagent/runs/<run-id>/evidence/security/
```

Catatan: ZAP passive/active scan penuh masih menjadi future external adapter.

## Load Smoke

Load smoke berjalan saat layer `load` dipilih, tetapi selalu membutuhkan opt-in:

```yaml
safety:
  load_test: true
```

Adapter:

```text
http-load-smoke
```

Engine:

```text
http-smoke
```

Contoh config:

```yaml
safety:
  load_test: true
  max_concurrency: 2

load:
  include: [/]
  requestsPerTarget: 3
  concurrency: 2
  thresholds:
    maxErrorRate: 0
    maxAverageMs: 1000
    maxP95Ms: 2000

tests:
  layers: [load]
```

Jalankan:

```bash
npm run qagent -- run --url http://localhost:3000 --config qa.config.yaml
```

Jika `safety.load_test` tidak `true`, adapter berhenti sebelum menghubungi target. Production target tetap diblokir oleh safety policy.

Evidence ditulis ke:

```text
.qagent/runs/<run-id>/evidence/load/
```

Catatan: skenario k6 penuh masih menjadi future external adapter.

## Dashboard

Dashboard lokal berjalan di:

```text
http://127.0.0.1:4810
```

Jalankan:

```bash
npm run qagent -- dashboard
```

Default dashboard bersifat read-only. Endpoint yang tersedia:

- `GET /health`
- `GET /ready`
- `GET /api/v1/projects`
- `GET /api/v1/runs`
- `GET /api/v1/runs/:runId`
- `GET /api/v1/runs/:runId/report`
- `GET /api/v1/findings`
- `GET /api/v1/baselines`
- `GET /api/v1/evidence/:id`
- `GET /api/v1/system/diagnostics`

Run trigger API hanya aktif jika dashboard dijalankan dengan:

```bash
npm run qagent -- dashboard --allow-run-trigger
```

Saat aktif, endpoint berikut tersedia:

```text
POST /api/v1/runs
```

Body harus berisi tepat salah satu dari `url` atau `sourcePath`.

Contoh PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4810/api/v1/runs -ContentType 'application/json' -Body '{"url":"http://127.0.0.1:3234","layers":["security"]}'
```

## Smoke Test Lokal

Browser/cloud smoke:

```bash
node tests/fixtures/cloud-good-server.mjs
npm run qagent -- run --url http://127.0.0.1:3210
```

Security passive:

```bash
node tests/fixtures/security-server.mjs
npm run qagent -- run --url http://127.0.0.1:3234 --layers security
```

Performance:

```bash
node tests/fixtures/performance-server.mjs
npm run qagent -- run --url http://127.0.0.1:3233 --layers performance
```

Load smoke perlu config opt-in seperti bagian Load Smoke.

## Validasi Release

Gunakan:

```bash
npm run release:check
```

Script ini menjalankan:

- typecheck
- full test suite
- audit offline npm
- `npm pack --dry-run`

Package manifest hanya memasukkan output `dist/`, schema publik, examples, README, dan package metadata. Artifact run lokal dan test fixtures tidak ikut payload release.

## Exit Code

- `0`: quality gate passed
- `1`: quality gate failed
- `2`: configuration/validation error
- `3`: runner/internal error
- `4`: unsafe/disallowed operation
- `130`: cancelled/interrupted

## Prinsip Keamanan

- Tidak ada credential mentah di report/log.
- URL target divalidasi sebelum dijalankan.
- Production target dilindungi dari destructive test, active scan, dan load test.
- Source Mode tidak menjalankan script tanpa opt-in.
- Evidence dibatasi dan disanitasi sebelum disimpan.
- Adapter failure menjadi result `ERROR` atau `BLOCKED`, bukan membuat report hilang.
