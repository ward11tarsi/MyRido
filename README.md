# MyRido — Mobility & Vehicle Rental Platform

**Brand Name:** MyRido  
**Company Name:** MyRido Private Limited  
**Website:** https://myrido.co  
**Registered Address:** 178, RukmaniVihar, Vrindavan, Mathura, Uttar Pradesh - 281121, India.  
**MCA:** `U49223UW2026PTC257678` | **PAN:** `AAVCM4084E` | **TAN:** `AGRM16866D` | **GST:** `09AAVCM4084E1ZZ`

---

## Architecture Overview

MyRido connects **one Universal Web Application**, **three Dedicated Desktop Applications**, and **four Dedicated Mobile Applications (Android + iOS = 8 mobile builds)** to **one centralized Express/TypeScript API backend** and **one central Supabase PostgreSQL database**:

- **Universal Web Application (`web-universal`):** Public zero-PII fleet catalog (`PublicFleetView`) + role-scoped Customer, Partner, Admin, and SuperAdmin workspaces (`src/App.tsx`).
- **Dedicated Desktop Applications (`apps/desktop/` — Electron):**
  - `apps/desktop/partner-desktop` (`co.myrido.partner.desktop`)
  - `apps/desktop/admin-desktop` (`co.myrido.admin.desktop`)
  - `apps/desktop/superadmin-desktop` (`co.myrido.superadmin.desktop`)
- **Dedicated Mobile Applications (`apps/mobile/` — Capacitor Android & iOS):**
  - `apps/mobile/customer-app` (`co.myrido.customer`)
  - `apps/mobile/partner-app` (`co.myrido.partner`)
  - `apps/mobile/admin-app` (`co.myrido.admin`)
  - `apps/mobile/superadmin-app` (`co.myrido.superadmin`)

---

## Approved Technology Stack

- **Database & Storage:** Supabase (`@supabase/supabase-js`, Row Level Security, private `myrido-protected-docs` storage bucket, atomic `credit_wallet_atomic` RPC)
- **Payments & Refunds:** Cashfree Payment Gateway (`v2023-08-01` PG Orders, Payments verification, Refunds, HMAC-SHA256 Webhooks)
- **KYC Verification:** Cashfree Verification Suite (Customer: Driving Licence + Aadhaar OKYC ONLY; Partner Individual: Aadhaar OKYC OTP + PAN; Partner Business: GSTIN + Company PAN + optional MCA CIN)
- **OTP / SMS:** Fast2SMS OTP API (`https://www.fast2sms.com/dev/bulkV2`)

---

## Setup & Database Migrations

1. Copy `.env.example` to `.env` and fill in your credentials (`SUPABASE_*`, `CASHFREE_*`, `FAST2SMS_*`, `MYRIDO_SESSION_SECRET`, `APP_URL`).
   - In `NODE_ENV=production`, the backend **fails closed** (`503 SUPABASE_NOT_CONFIGURED`) if `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is missing.
2. In your Supabase project SQL Editor, apply:
   - `supabase/schema.sql` for a fresh database (full schema, RLS policies, private `myrido-protected-docs` bucket, RPCs), or
   - on an existing database, every file in `supabase/migrations/` in order (`001` … `009`).
   - **`009_data_layer_integrity.sql` is required in production**: it adds `weekly_payout_batches` and the single-writer lease functions; the server refuses to start without them.
3. Configure Cashfree Webhook endpoint in the Cashfree Dashboard:
   - `<APP_URL>/api/webhooks/cashfree`

---

## Key Commands

```bash
# Install dependencies
npm install

# Run automated API, security, payment, KYC & target tests
npm test

# TypeScript check
npm run lint

# Start development server (Express API + Vite middleware on port 3000)
npm run dev

# Build production web SPA + Node server bundle (dist/server.mjs)
npm run build

# Start production server
npm run start

# Rebuild all 8 shared web bundles for web, desktop & mobile targets
MYRIDO_API_BASE_URL="https://api.myrido.co" npm run build:targets
```

---

## Native Desktop & Mobile Packaging

The shared target build script (`scripts/build-targets.mjs`) outputs web bundles directly into `apps/desktop/*/web` and `apps/mobile/*/web` with `src/apps/appTargets.ts` resolving runtime Android vs iOS target IDs dynamically.

- **Electron Desktop (`.exe` / `.dmg` / `.AppImage`):**
  ```bash
  cd apps/desktop/partner-desktop
  npm install && npm run dist
  ```
- **Capacitor Mobile (Android `.apk`/`.aab` & iOS `.ipa`):**
  ```bash
  cd apps/mobile/customer-app
  npm install && npx cap add android && npx cap add ios && npx cap sync
  ```
  Open the generated Android/iOS native projects in Android Studio / Xcode on their respective host platforms to sign and archive `.aab`/`.apk` and `.ipa` binaries.

---

## Runtime Notes

- `PORT` env var sets the server port (default `3000`).
- In production the server refuses to start if `SUPABASE_*` is configured but the initial Supabase snapshot cannot be loaded, and exits on uncaught exceptions so a process manager (PM2, Docker, Cloud Run) can restart it cleanly. `SIGTERM`/`SIGINT` close the HTTP server gracefully.
- All responses carry baseline security headers (`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and HSTS in production).
- Role workspaces (`src/workspaces/*`) and `ProfileSettingsView` are lazy-loaded, so each user downloads only their own dashboard.
- Older AI-generated status reports were moved to `docs/archive/`. They describe intended behaviour and are not a reliable record of what the code does.

## Sign-in & Admin Management

- **Everyone signs in with mobile OTP** (Customer, Partner, Admin, SuperAdmin). The account type is recognised from the number; one mobile number = one account.
- A **new number** is asked once to register as **Customer** or **Vehicle Partner**. Nobody can self-register as Admin or SuperAdmin.
- **SuperAdmin** = the number in `MYRIDO_SUPERADMIN_PHONE`. On startup the SuperAdmin account is created or moved to that number; no other number can sign in as SuperAdmin, and the SuperAdmin role cannot be given to anyone else.
- **Only the SuperAdmin manages Admins** (Governance → Admin management): add an Admin with name + mobile, choose for each dashboard section whether it is shown and what the Admin may change, edit those permissions later, or delete the Admin (soft delete: signed out at once, audit history kept; the number can be re-added). Admins cannot create Admins.
- Admins only receive data for sections they were granted (`/api/workspace/bootstrap`, `/api/ops/records`).
- Password sign-in is off; `MYRIDO_ENABLE_PASSWORD_LOGIN=true` re-enables the legacy endpoint (used by regression tests).
- Apply `supabase/migrations/010_admin_lifecycle.sql` (allows profile status `DELETED`).

## Hubs, Areas & Live Tracking

- **Hubs:** only the SuperAdmin adds or deletes hubs (SuperAdmin → Hubs). A hub that still has vehicles or bookings cannot be deleted; pause it instead. Admins with "Pause / resume hubs" can only pause or reopen hubs in their areas.
- **Admin areas:** when creating or editing an Admin, the SuperAdmin picks *All areas* or specific cities (stored as `AREA:*` / `AREA:<City>` in the Admin permissions). Admins created earlier without an area keep access to all areas until restricted.
- **Live tracking** (`GET /api/ops/live-tracking`, refreshed every 15 s) lists vehicles that have a real GPS source (device or phone) with their current rider:
  - SuperAdmin — every vehicle, full rider phone (call button).
  - Admin — needs the "Live tracking" section and sees only their areas; rider phone masked.
  - Partner — only their own vehicles; rider phone masked (Partner → Monitoring).
- **Vehicle types:** only **Car, Bike, Scooty**. Apply `supabase/migrations/011_vehicle_types_car_bike_scooty.sql` to convert old values (hatchback/sedan/suv → car, ev_scooter → scooty).

## Data Layer

- Supabase is the source of truth. On startup the server loads a snapshot of the database into memory and every change is written through to Supabase.
- **Single writer:** because of that in-memory working copy, only one API instance may write at a time. The server claims a lease in `server_instance_leases` at startup and renews it every 15 s. A newly started instance takes over (rolling deploys work); the old one notices on its next heartbeat and shuts down. Still configure your host for **one instance** (e.g. Cloud Run `--max-instances=1`, PM2 `instances: 1`). `MYRIDO_DISABLE_INSTANCE_LEASE=true` turns the lease off.
- **Local JSON file** (`data/myrido-store.json`) is used only when Supabase is not configured (development). Writes are asynchronous, coalesced and atomic (temp file + rename). With Supabase configured the file is neither read nor written; set `MYRIDO_LOCAL_STORE_CACHE=true` to keep it for debugging.
- Push device tokens, monitoring error events and weekly payout batches are now persisted **and** reloaded on startup (previously they were lost on restart).

### SMS OTP (Fast2SMS DLT)

Indian telecom rules need a DLT-approved sender header and template. On your DLT operator portal register the header (e.g. `MYRIDO`) and an OTP template such as `{#var#} is your MyRido login OTP. Do not share it with anyone. - MyRido`, then add both in Fast2SMS → DLT Manager (Sender ID, Content Template). Set `FAST2SMS_ROUTE=dlt`, `FAST2SMS_SENDER_ID=MYRIDO` and `FAST2SMS_DLT_MESSAGE_ID=<Message ID shown in Fast2SMS>`.

### Aadhaar KYC (DigiLocker) and hand review

Cashfree discontinued Aadhaar OTP (OKYC), so Aadhaar is verified through **DigiLocker** (`/api/kyc/cashfree/digilocker/start` and `/complete`). People without a DigiLocker account can create one inside the flow with Aadhaar and the OTP sent to their Aadhaar-linked mobile. Set `APP_URL` to the public **https** address so DigiLocker can send people back (`/<role>/kyc?digilocker=done`); the original tab checks the result by itself.

If a person's mobile is not linked to Aadhaar, they upload an Aadhaar card photo and a selfie. A KYC reviewer (Admin with `KYC_REVIEW`) can then use **Review by hand** (`MANUAL_APPROVE`). This is allowed only after the Driving Licence (customer) or PAN (partner) passed Cashfree, and the reviewer's note is written to the audit log.

The Cashfree Secure ID account uses 2FA with a public key: set `CASHFREE_KYC_PUBLIC_KEY` (PEM on one line with \n) or `CASHFREE_KYC_PUBLIC_KEY_PATH`.

## Known Gaps (not yet fixed)

1. **Horizontal scaling:** the in-memory working copy means the API cannot run as several parallel instances. Moving reads to Supabase queries per request is the long-term fix.
2. **Rate limits** (OTP / login) live in process memory and reset on restart.
3. **Auth token** is stored in `localStorage`; moving it to an `httpOnly` cookie and adding a Content-Security-Policy would reduce XSS impact.
4. **WebSocket auth** sends the session token as a `?token=` query parameter, which can end up in proxy logs.
5. **Large files:** `server/app.ts` (~10k lines) and the workspace components (up to ~5.6k lines) should be split into route/service modules and smaller components.
6. **Images** in `src/assets/images` (~3.2 MB JPG) should be converted to WebP and lazy-loaded.
