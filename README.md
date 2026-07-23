# Checkpoint Key System (Adsterra)

ระบบแจกคีย์แบบผ่าน Checkpoint 1→4 ต่อกันเป็นสเต็ป ใช้คู่กับ **Adsterra**
มีระบบ **ตรวจจับ Ad Blocker** (เจอแล้วเข้าเว็บไม่ได้), **แจกคีย์อัตโนมัติจากสต็อกไฟล์ `keys.txt`**,
และ **ระบบกันบอท/กันเจาะ** ในตัว — เขียนด้วย Node.js + Express, deploy บน Railway ได้ทันที

---

## ทำอะไรได้บ้าง

- **Ad Blocker detection** — ตรวจ 3 วิธี (bait element + สคริปต์ `/ads.js` + fetch bait) ถ้าเจอตัวบล็อกจะไม่ให้เข้าหน้าคีย์
- **Checkpoint แบบต่อเนื่อง** — ต้องผ่าน Checkpoint 1 ก่อนถึงจะไป 2, 3, 4 (บังคับลำดับที่ฝั่งเซิร์ฟเวอร์ ข้ามไม่ได้)
- **นับเวลาอยู่หน้าโฆษณา** — แต่ละด่านต้องอยู่ครบเวลา (ตั้งได้) ก่อนกด "ยืนยัน" กันการรัวข้าม
- **แจกคีย์อัตโนมัติ** — พอครบทุกด่าน ระบบดึงคีย์ 1 ตัวจาก `keys.txt` ให้ และตัดออกจากสต็อก
- **กันบอท/กันเจาะ** — Rate limit ต่อ IP, honeypot, ตรวจ User-Agent, token เซ็นด้วย HMAC ปลอมไม่ได้, กันเคลมซ้ำ (refresh กี่ครั้งก็ได้คีย์เดิม ไม่กินสต็อก)

---

## โครงสร้างไฟล์

```
checkpoint-key-system/
├─ server.js            # เซิร์ฟเวอร์หลัก (API + ความปลอดภัย + จ่ายคีย์)
├─ package.json
├─ programs.json        # รายชื่อโปรแกรม (id + ชื่อ + คำอธิบาย + ลำดับ)
├─ keys/                # สต็อกคีย์ แยกไฟล์ตามโปรแกรม
│  ├─ program-1.txt     #   คีย์ของ "โปรแกรม 1" (1 บรรทัด = 1 คีย์)
│  ├─ program-2.txt
│  └─ program-3.txt
├─ .env.example
├─ .gitignore
└─ public/
   ├─ index.html        # หน้าเว็บ (gate / blocked / checkpoint / เลือกโปรแกรม / คีย์)
   ├─ style.css
   └─ app.js            # ลอจิกฝั่งผู้ใช้
```

---

## รันในเครื่อง (local)

```bash
npm install
cp .env.example .env      # แล้วแก้ค่าใน .env
npm start                 # เปิด http://localhost:3000
```

---

## Deploy บน Railway

1. อัปโปรเจกต์นี้ขึ้น GitHub (repo ใหม่)
2. Railway → **New Project → Deploy from GitHub repo** → เลือก repo นี้
3. Railway จะเจอ `package.json` และรัน `npm start` ให้เอง (ตรวจว่า Start Command = `npm start`)
4. ไปที่แท็บ **Variables** แล้วใส่ค่าตามตารางด้านล่าง (อย่างน้อยต้องมี `SECRET_KEY`)
5. กด Deploy → เปิด URL ที่ Railway ให้มา

> **สำคัญ:** ตั้ง `SECRET_KEY` เป็นสตริงยาว ๆ แบบสุ่มเสมอ ถ้าไม่ตั้ง เซิร์ฟเวอร์จะสุ่มให้ใหม่ทุกครั้งที่รีสตาร์ท ทำให้เซสชันผู้ใช้หลุดหมด
> สร้างค่าได้ด้วย: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## ตัวแปร Environment

| ตัวแปร | ค่าเริ่มต้น | คำอธิบาย |
|---|---|---|
| `SECRET_KEY` | *(สุ่ม)* | **จำเป็น** คีย์ลับสำหรับเซ็น token |
| `TOTAL_CHECKPOINTS` | `4` | จำนวนด่านก่อนได้คีย์ (1–12) |
| `CHECKPOINT_COOLDOWN` | `15` | วินาทีที่ต้องอยู่หน้าโฆษณาต่อด่าน |
| `TOKEN_TTL` | `3600` | อายุ token (วินาที) |
| `ADSTERRA_LINKS` | *(ว่าง)* | ลิงก์ Adsterra Direct Link คั่นด้วย `,` (ทีละด่าน) |
| `ADMIN_TOKEN` | *(ว่าง)* | โทเคนสำหรับ `/api/admin/reload` |
| `DATA_DIR` | โฟลเดอร์โปรเจกต์ | ชี้ไป Volume เพื่อเก็บคีย์ถาวร |
| `NODE_ENV` | `development` | ตั้งเป็น `production` ตอนใช้จริง (เปิด secure cookie) |

---

## ตั้งค่า Adsterra

1. ใน Adsterra ทำ **Direct Link** สำหรับเว็บของคุณ (จะได้ URL มา)
2. เอา URL ใส่ใน `ADSTERRA_LINKS` เช่นด่านละลิงก์:
   ```
   ADSTERRA_LINKS=https://xxx1.com,https://xxx2.com,https://xxx3.com,https://xxx4.com
   ```
   ถ้าใส่ลิงก์เดียว ระบบจะใช้ลิงก์นั้นทุกด่าน
3. (แนะนำ) วางสคริปต์ **Social Bar / Native Banner / Popunder** ของ Adsterra ไว้ในส่วนที่มีคอมเมนต์
   `==== ADSTERRA SCRIPTS GO HERE ====` ในไฟล์ `public/index.html`

---

## จัดการโปรแกรมและคีย์

หลังผ่าน Checkpoint สุดท้าย ผู้ใช้จะเห็นหน้า **"เลือกโปรแกรม"** แต่ละโปรแกรมมีสต็อกคีย์แยกไฟล์กัน

**1. กำหนดรายชื่อโปรแกรม** ในไฟล์ `programs.json`:
```json
[
  { "id": "program-1", "name": "โปรแกรม 1", "desc": "คำอธิบาย (จะโชว์ใต้ชื่อ)" },
  { "id": "program-2", "name": "โปรแกรม 2", "desc": "" }
]
```
- `id` = ชื่อไฟล์คีย์ (ต้องมี `keys/<id>.txt` ตรงกัน) ห้ามมีเว้นวรรค
- `name` = ชื่อที่โชว์บนปุ่ม · `desc` = คำอธิบาย (เว้นว่างได้)
- ลำดับใน `programs.json` = ลำดับที่โชว์บนหน้าเว็บ
- ถ้าไม่มี `programs.json` ระบบจะสร้างรายการจากไฟล์ใน `keys/` อัตโนมัติ

**2. ใส่คีย์** ในไฟล์ `keys/<id>.txt` บรรทัดละ 1 คีย์ (บรรทัดขึ้นต้น `#` = คอมเมนต์)

- พอมีคนเลือกโปรแกรมไหนแล้วได้คีย์ ระบบจะ **ตัดคีย์นั้นออกจากไฟล์ของโปรแกรมนั้น** และบันทึกลง `used_keys.txt` (มีคอลัมน์บอกว่าเป็นคีย์ของโปรแกรมไหน)
- เพิ่มโปรแกรม/คีย์ใหม่: แก้ `programs.json` หรือไฟล์ใน `keys/` แล้วโหลดใหม่โดย **ไม่ต้องรีสตาร์ท**:
  ```bash
  curl -X POST https://<your-app>.up.railway.app/api/admin/reload \
       -H "x-admin-token: <ADMIN_TOKEN ของคุณ>"
  ```
  หรือรีสตาร์ท service ก็ได้

> หมายเหตุ: 1 เซสชัน (ผ่าน checkpoint 1 รอบ) เลือกได้ **1 โปรแกรม / 1 คีย์** ถ้า refresh แล้วทำใหม่ ถึงจะเลือกได้อีกรอบ

### ⚠️ เก็บคีย์ให้ถาวรบน Railway (สำคัญมาก)

ระบบไฟล์ของ Railway เป็นแบบชั่วคราว — **ทุกครั้งที่ deploy ใหม่ ไฟล์จะกลับไปเป็นค่าใน Git**
แปลว่าคีย์ที่จ่ายไปแล้วอาจ "กลับมา" และประวัติ `used_keys.txt` จะหาย

วิธีแก้: ผูก **Volume** แล้วชี้ `DATA_DIR` ไปที่นั่น
1. Railway → service → **Variables** → เพิ่ม `DATA_DIR=/data`
2. แท็บ **Settings → Volumes** → Mount ที่ `/data`
3. รอบแรกระบบจะก๊อปโฟลเดอร์ `keys/` และ `programs.json` จาก repo ไปไว้ใน `/data` ให้เอง หลังจากนั้นแก้คีย์/โปรแกรมผ่าน Volume

---

## ระบบความปลอดภัย (กันเจาะ / กันบอท)

- **Token เซ็นด้วย HMAC-SHA256** — สถานะด่านอยู่ในโทเคน ปลอม/แก้ค่าไม่ได้ถ้าไม่มี `SECRET_KEY`
- **บังคับลำดับด่าน** — จะขอโทเคนด่าน N+1 ได้ต้องผ่านด่าน N จริง ข้ามไปหน้าเคลมคีย์ตรง ๆ ไม่ได้
- **Cooldown ต่อด่าน** — เซิร์ฟเวอร์เช็กเวลาที่ผ่านไปจริง กดเร็วเกิน = ปฏิเสธ (กันสคริปต์รัว)
- **Rate limit** — จำกัดคำขอต่อ IP (`/api/` 40/นาที, เคลมคีย์ 12/นาที) กันยิงบอทรัว ๆ
- **Honeypot + ตรวจ UA** — กันบอทอัตโนมัติเบื้องต้น
- **เคลมคีย์แบบ idempotent** — 1 เซสชันได้ 1 คีย์ refresh ซ้ำได้คีย์เดิม ไม่กินสต็อก
- **helmet** — ตั้ง security header ให้อัตโนมัติ (รวม HSTS)
- **Cache-Control: no-store** บนทุก response ของ `/api/` — กันคีย์/โทเคนถูก cache ที่ browser/proxy/CDN
- **Cloudflare Turnstile (CAPTCHA ฟรี)** ที่ด่านแรก — กันบอทที่รัน flow อัตโนมัติ (เปิดใช้เมื่อใส่ env `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` ถ้าเว้นว่างไว้ ระบบจะข้ามให้เอง ไม่พัง)

### เปิดใช้ Cloudflare Turnstile (แนะนำ)
1. Cloudflare dashboard → **Turnstile** → **Add site** → ใส่โดเมนของคุณ
2. ก๊อป **Site Key** และ **Secret Key** มาใส่ใน Railway Variables:
   `TURNSTILE_SITE_KEY=...` และ `TURNSTILE_SECRET_KEY=...`
3. redeploy — หน้าแรกจะขึ้นกล่องยืนยัน "ไม่ใช่บอท" ก่อนเข้าสู่ checkpoint และเซิร์ฟเวอร์จะ verify token ก่อนออก session ให้

### ข้อจำกัดที่ควรรู้ (ตรงไปตรงมา)
- **การตรวจ Ad Blocker ทำฝั่ง browser** ผู้ใช้ที่รู้เทคนิคจริง ๆ ยังหลบได้ (ปิด JS, แก้ DOM) — ไม่มีเว็บไหนกันได้ 100% ระบบนี้กันได้ระดับ "คนทั่วไปที่เปิด AdBlock" ซึ่งครอบคลุมส่วนใหญ่
- **การอยู่หน้าโฆษณาจริงยืนยันไม่ได้ 100%** เพราะ Adsterra Direct Link ไม่มี server-side postback เรากันด้วย "เวลาขั้นต่ำ + โทเคน" ซึ่งกันการข้าม/สคริปต์ได้ดี แต่ไม่ใช่การพิสูจน์ว่าดูโฆษณาแน่นอน
- อยากแน่นหนาขึ้น: เพิ่ม Cloudflare (กัน DDoS/บอทระดับ network) หน้าเว็บ, ใช้ Turnstile/CAPTCHA ที่ด่านแรก, และย้ายสต็อกไป Database

---

## ปรับแต่งด่วน

- อยากได้ **มากกว่า/น้อยกว่า 4 ด่าน** → เปลี่ยน `TOTAL_CHECKPOINTS`
- อยาก **บังคับดูโฆษณานานขึ้น** → เพิ่ม `CHECKPOINT_COOLDOWN`
- อยากเปลี่ยนสี/ข้อความ → แก้ `public/style.css` และ `public/index.html`
