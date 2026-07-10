# Auth System — Skill Reference

This doc captures the full authentication system implemented in `feature/dual-portal-xtream-support` (commit `54846ea`). Reference this before touching anything in `src/routes/auth.ts`, `src/utils/jwt.ts`, `src/utils/password.ts`, `src/utils/email.ts`, or `src/models/User.ts` / `src/models/DeviceCode.ts`.

---

## Overview

Two login methods: **Google OAuth** and **email/password**. Both share the same JWT token system and the same admin-approval gate for non-admin users.

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth audience for verifying ID tokens |
| `ADMIN_EMAIL` | Primary admin email (auto-bootstrapped as admin) |
| `ADMIN_EMAILS` | Comma-separated list of additional admin emails |
| `ADMIN_PASSWORD` | Env-level admin password (bypasses DB check) |
| `JWT_SECRET` | Secret used to sign/verify all JWTs |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Nodemailer config for approval emails |

---

## Auth Flow

### Google OAuth (`POST /api/auth/google`)
1. Frontend passes a Google `idToken` + `clientType` (`"web"` or `"tv"`)
2. Server verifies token with `google-auth-library`
3. If email matches `ADMIN_EMAIL` / `ADMIN_EMAILS` → auto-bootstrap or promote to admin, skip approval
4. New non-admin user → created as `isActive: false`, admin approval email sent via SMTP → returns `403`
5. Existing inactive user → returns `403` (pending approval)
6. Existing active user → issues tokens

### Email/Password Login (`POST /api/auth/login`)
- Admin check: if email is in admin list AND password matches `ADMIN_PASSWORD` → auto-bootstrap admin and issue tokens (no DB password needed)
- Regular users: `verifyPassword(password, user.passwordHash, user.salt)` using PBKDF2
- Users without `passwordHash` are Google-only → returns hint to use Google Sign-In

### Signup (`POST /api/auth/signup`)
- Creates user as `isActive: false`, sends admin approval email
- Admin must activate via `PUT /api/admin/users/{id}` with `isActive: true`
- Activation triggers `sendUserApprovedEmail` to notify the user

### Token Refresh (`POST /api/auth/refresh`)
- Accepts a refresh token, verifies it has `type: "refresh"`
- Issues a new access token; refresh token is reused (not rotated)

---

## JWT Tokens

- **Access token:** 1 hour TTL, contains `{ userId, email, role }`
- **Refresh token:** 30 days (web) or 6 months (TV), contains `{ userId, type: "refresh", clientType }`
- **Stream token:** 30-day TTL, contains `{ sub: userId, scope: "stream" }` — returned as `user_info.password` in Xtream `player_api.php` responses so IPTV players never carry the real password in stream URLs. See [[skill-xtream-provider]] for details.
- All protected routes call `authCheck(request)` from `src/utils/jwt.ts` which reads `Authorization: Bearer <token>`

---

## Device Code Flow (TV Auth)

TV clients can't do browser-based OAuth. Flow:

1. TV calls `POST /api/auth/device/code` → gets `{ deviceCode, userCode, verificationUrl, expiresIn: 300 }`
2. `userCode` is a human-friendly `ABC-DEF` format (6 chars, readable alphabet only)
3. User opens `verificationUrl` (e.g. `http://server/#/verify?code=ABC-DEF`) on their phone/PC, authenticates there
4. TV polls `POST /api/auth/device/poll` with `{ deviceCode }` every few seconds
5. Poll returns `{ status: "pending" | "authorized" | "expired" }` — when authorized, includes tokens
6. `DeviceCode` records expire after 5 minutes

---

## User Roles

| Role | Permissions |
|------|------------|
| `admin` | Full access to `/api/admin/*` routes; auto-activated |
| `user` | Access to `/api/user/*` routes; requires admin activation |

Admin self-protection guards prevent: disabling own account, downgrading own role, deleting own account.

---

## API Endpoints Summary

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/google` | Google OAuth login |
| `POST` | `/api/auth/login` | Email/password login |
| `POST` | `/api/auth/signup` | Register (creates inactive user) |
| `POST` | `/api/auth/refresh` | Refresh access token |
| `POST` | `/api/auth/device/code` | Get device code (TV) |
| `POST` | `/api/auth/device/poll` | Poll for TV auth result |
| `POST` | `/api/auth/device/activate` | Activate a device code (from browser) |

---

## Key Files

- `src/routes/auth.ts` — all auth endpoints
- `src/utils/jwt.ts` — `createJWT`, `verifyJWT`, `authCheck`
- `src/utils/password.ts` — `hashPassword`, `verifyPassword` (PBKDF2)
- `src/utils/email.ts` — `sendAdminApprovalRequest`, `sendUserApprovedEmail` (nodemailer)
- `src/models/User.ts` — User Sequelize model
- `src/models/DeviceCode.ts` — DeviceCode Sequelize model