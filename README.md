<div align="center">

# 🧪 QAgent

### Automated Web QA Runner

**Test • Detect • Compare • Report**

Runner QA otomatis berbasis CLI untuk menguji aplikasi web dari **URL** maupun **source code project**.

![Node.js](https://img.shields.io/badge/Node.js-24+-339933?logo=node.js\&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript\&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-Browser_Testing-2EAD33?logo=playwright\&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-Local_Storage-003B57?logo=sqlite\&logoColor=white)
![CLI](https://img.shields.io/badge/CLI-First-black?logo=gnubash\&logoColor=white)

</div>

---

## ✨ Tentang QAgent

QAgent adalah runner QA otomatis berbasis CLI yang dirancang untuk melakukan pengujian aplikasi web secara **stabil, deterministik, aman, dan ringan**.

QAgent dapat digunakan secara lokal maupun diintegrasikan ke dalam pipeline CI/CD.

### 🔍 Apa yang dapat diuji?

| Area                 | Kemampuan                          |
| -------------------- | ---------------------------------- |
| 🌐 **Browser**       | Playwright browser automation      |
| 🔌 **API**           | HTTP/API assertion                 |
| 🔐 **Authorization** | RBAC allow/deny validation         |
| ♿ **Accessibility**  | axe-core accessibility scanning    |
| ⚡ **Performance**    | Browser timing & resource analysis |
| 🛡️ **Security**     | Passive HTTP security checks       |
| 🚦 **Load**          | Controlled HTTP load smoke testing |
| 🔄 **Regression**    | Baseline & regression comparison   |
| 📊 **Reporting**     | HTML, JSON, JUnit, XLSX            |
| 🖥️ **Dashboard**    | Local QA dashboard                 |

---

## 🚀 Mulai Cepat

### 1️⃣ Install

```bash
npm install
npx playwright install chromium
npm run build
```

### 2️⃣ Initialize

```bash
npm run qagent -- init
npm run qagent -- doctor
```

### 3️⃣ Jalankan QA

```bash
npm run qagent -- run --url http://localhost:3000
```

---

## 🧩 Mode Pengujian

QAgent memiliki dua mode utama.

### ☁️ Cloud Mode

Digunakan untuk menguji aplikasi melalui URL.

```bash
npm run qagent -- run --url http://localhost:3000
```

Cocok untuk:

* 🌐 Browser testing
* 🔌 API testing
* 🔐 RBAC testing
* ♿ Accessibility
* ⚡ Performance
* 🛡️ Security
* 🚦 Load smoke

### 📂 Source Mode

Digunakan untuk menganalisis source code project.

```bash
npm run qagent -- run .
```

Dengan izin menjalankan source command:

```bash
npm run qagent -- run . --allow-source-commands
```

Source Mode dapat memeriksa:

* 🔎 Runtime detection
* 🧹 Lint
* 🧠 Typecheck
* 🧪 Test
* 📦 Build

---

## 🧪 Testing Layers

### 🌐 Browser Testing

Browser automation menggunakan **Playwright**.

```bash
npm run qagent -- run --url http://localhost:3000
```

QAgent dapat mendeteksi:

* Console error
* Network failure
* HTTP failure
* Redirect
* Form
* Button
* Page discovery
* Endpoint HTTP/API

---

### 🔌 API Testing

API assertion dikonfigurasi melalui YAML.

```yaml
api:
  assertions:
    - key: health
      method: GET
      path: /health
      expected_status: 200
```

---

### 🔐 RBAC / Authorization

Memastikan suatu role hanya dapat mengakses resource yang diperbolehkan.

```text
Learner
   │
   ▼
GET /admin/users
   │
   ▼
200 OK
   │
   ▼
🚨 Authorization Bypass
```

---

### ♿ Accessibility

Menggunakan:

```text
axe-core
```

Jalankan:

```bash
npm run qagent -- run --url http://localhost:3000 --layers accessibility
```

Default quality gate:

* 🔴 Critical → FAIL
* 🟠 Serious → FAIL

---

### ⚡ Performance

Menggunakan:

```text
browser-performance
      ↓
browser-timing
```

Memeriksa:

* First Byte
* DOM Content Loaded
* Load Event
* Transfer Size
* Resource Count

Jalankan:

```bash
npm run qagent -- run --url http://localhost:3000 --layers performance
```

---

### 🛡️ Passive Security

Memeriksa konfigurasi keamanan HTTP secara pasif.

```bash
npm run qagent -- run --url http://localhost:3000 --layers security
```

Pemeriksaan meliputi:

* 🔐 Content Security Policy
* 🖼️ Frame Protection
* 📄 X-Content-Type-Options
* 🔗 Referrer Policy
* 🔒 Strict Transport Security
* 🍪 HttpOnly Cookie
* 🍪 Secure Cookie
* 🍪 SameSite Cookie

> QAgent tidak melakukan active exploitation atau fuzzing melalui adapter passive security.

---

### 🚦 Load Smoke

Load testing memerlukan izin eksplisit.

```yaml
safety:
  load_test: true
```

Hal ini mencegah load test berjalan secara tidak sengaja terhadap target.

---

## 🔄 Regression Testing

### Buat baseline

```bash
npm run qagent -- baseline create --run RUN_ID --name stable
```

### Bandingkan run baru

```bash
npm run qagent -- compare --run RUN_ID --baseline stable
```

Alurnya:

```text
🟢 Stable Run
      │
      ▼
📌 Baseline
      │
      ▼
🔧 Application Change
      │
      ▼
🧪 New Test Run
      │
      ▼
🔄 Compare
      │
      ▼
📊 Regression Result
```

QAgent dapat mendeteksi:

* 🔴 New Failure
* ⚠️ Missing Test
* 🔄 Status Change
* 🟢 Resolved Failure

---

## 📊 Reports

Setiap run menghasilkan artifact pada:

```text
.qagent/runs/<run-id>/
```

Struktur:

```text
📁 .qagent/
└── 📁 runs/
    └── 📁 <run-id>/
        ├── 🌐 report.html
        ├── 📄 report.json
        ├── 📊 report.xlsx
        ├── 🧪 junit.xml
        └── 📁 evidence/
```

| Report           | Kegunaan                    |
| ---------------- | --------------------------- |
| 🌐 `report.html` | Membaca hasil secara visual |
| 📄 `report.json` | Machine-readable output     |
| 🧪 `junit.xml`   | CI/CD integration           |
| 📊 `report.xlsx` | Dokumentasi dan analisis QA |
| 📸 `evidence/`   | Evidence hasil pengujian    |

---

## 🖥️ Dashboard

Jalankan:

```bash
npm run qagent -- dashboard
```

Dashboard tersedia di:

```text
http://127.0.0.1:4810
```

Dashboard digunakan untuk melihat:

* 📁 Projects
* 🧪 Runs
* 🚨 Findings
* 📸 Evidence
* 📌 Baselines
* 📊 Reports
* 🩺 Diagnostics

Secara default dashboard bersifat **read-only**.

---

## 🚦 Quality Gate

QAgent menggunakan hasil test untuk menentukan apakah sebuah run lolos.

### ✅ PASS

```text
Tests       7
Passed      7
Failed      0
Errors      0

Quality Gate ──► ✅ PASS
Exit Code   ──► 0
```

### ❌ FAILED

```text
Tests       7
Passed      6
Failed      1

Quality Gate ──► ❌ FAILED
Exit Code   ──► 1
```

Ini memungkinkan QAgent digunakan sebagai gate dalam CI/CD:

```text
          👨‍💻 Developer
               │
               ▼
           📤 Push
               │
               ▼
           📦 Build
               │
               ▼
          🧪 QAgent
               │
               ▼
        🚦 Quality Gate
           /         \
          /           \
      ✅ PASS        ❌ FAIL
         │              │
         ▼              ▼
      🚀 Deploy      🛑 Block
```

---

## 🛡️ Safety First

QAgent dirancang agar aman secara default.

| Protection               | Default  |
| ------------------------ | -------- |
| 🔒 Source command        | Disabled |
| 🚦 Load testing          | Disabled |
| 🏭 Production load test  | Blocked  |
| 🔑 Credential protection | Enabled  |
| 🌐 URL safety checks     | Enabled  |
| 📸 Evidence bounding     | Enabled  |
| 🧹 Credential redaction  | Enabled  |
| ⚙️ Concurrency limit     | Enabled  |

---

## 🏗️ Architecture

```text
                         🧪 QAgent
                            │
              ┌─────────────┴─────────────┐
              │                           │
        📂 Source Mode               ☁️ Cloud Mode
              │                           │
              ▼                           ▼
      Runtime Detection           Browser / HTTP
              │                           │
              ▼                           ▼
      Source Inspection             Test Layers
              │                           │
              └─────────────┬─────────────┘
                            │
                            ▼
                       🧪 Test Result
                            │
                            ▼
                       🚨 Findings
                            │
                            ▼
                       📸 Evidence
                            │
                            ▼
                       🗄️ SQLite
                            │
                            ▼
                     🚦 Quality Gate
                            │
                            ▼
                        📊 Report
```

---

## 🧰 Technology

| Technology    | Fungsi                |
| ------------- | --------------------- |
| 🟢 Node.js    | Runtime               |
| 🔷 TypeScript | Core development      |
| 🎭 Playwright | Browser automation    |
| ♿ axe-core    | Accessibility         |
| 🗄️ SQLite    | Local persistence     |
| 📊 XLSX       | Spreadsheet reporting |

---

## 🗺️ Roadmap

Future adapter:

* 🕷️ OWASP ZAP
* 🚀 k6
* 💡 Lighthouse
* 🐘 PostgreSQL centralized mode
* 🤖 AI-assisted QA
* 🧩 Plugin ecosystem
* 📚 Additional runtime adapters

---

## 💡 Design Principles

> 🎯 **Deterministic**
> Pengujian harus konsisten dan dapat direproduksi.

> 🛡️ **Safe by Default**
> Operasi berisiko membutuhkan izin eksplisit.

> ⌨️ **CLI First**
> Seluruh fungsi utama dapat digunakan dari terminal.

> 🌐 **Framework Independent**
> Cloud Mode bekerja melalui browser dan HTTP.

> 📸 **Evidence Driven**
> Failure harus memiliki informasi yang dapat ditelusuri.

> ♻️ **CI Friendly**
> Mendukung exit code, JUnit, JSON dan quality gate.

---

<div align="center">

### 🧪 QAgent

**Inspect · Test · Detect · Compare · Report**

*Automated web QA from source code to running applications.*

</div>
