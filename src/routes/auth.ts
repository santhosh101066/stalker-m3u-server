import { ServerRoute } from "@hapi/hapi";
import { OAuth2Client } from "google-auth-library";
import { User } from "../models/User";
import { DeviceCode } from "../models/DeviceCode";
import { createJWT, verifyJWT, authCheck } from "../utils/jwt";
import { v4 as uuidv4 } from "uuid";
import { verifyPassword, hashPassword } from "../utils/password";
import { sendAdminApprovalRequest } from "../utils/email";

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Helper to generate 6-character user friendly codes (e.g. AB-CDE)
function generateUserCode(): string {
  const chars = "ABCDEFGHIJKLMNPQRSTUVWXYZ23456789"; // readable chars
  let code = "";
  for (let i = 0; i < 6; i++) {
    if (i === 3) code += "-";
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Helper to sanitize code for comparison
function sanitizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-9]/g, "");
}

export const authRoutes: ServerRoute[] = [
  {
    method: "POST",
    path: "/api/auth/google",
    handler: async (request, h) => {
      try {
        const payload = request.payload as any;
        const idToken = payload?.idToken;
        const clientType = payload?.clientType || "web"; // 'web' or 'tv'

        if (!idToken) {
          return h.response({ error: "Missing ID Token" }).code(400);
        }

        let googlePayload;
        try {
          const ticket = await client.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
          });
          googlePayload = ticket.getPayload();
        } catch (err: any) {
          console.error("Google token verification failed:", err);
          return h.response({ error: "Invalid Google ID Token" }).code(401);
        }

        if (!googlePayload || !googlePayload.email) {
          return h.response({ error: "Failed to parse Google user payload" }).code(400);
        }

        const email = googlePayload.email.toLowerCase();
        const name = googlePayload.name || googlePayload.email.split("@")[0];
        const avatarUrl = googlePayload.picture || null;

        // Check if user is Admin
        const adminEmailStr = process.env.ADMIN_EMAIL || "";
        const adminEmailsList = (process.env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase());
        const isAdmin = email === adminEmailStr.toLowerCase() || adminEmailsList.includes(email);

        let user = await User.findOne({ where: { email } });

        if (isAdmin) {
          // Auto-bootstrap or update admin profile
          if (!user) {
            user = await User.create({
              email,
              name,
              role: "admin",
              isActive: true,
              avatarUrl,
              preferences: {
                preferredContentType: "movie",
                favorites: [],
                recentChannels: []
              }
            });
          } else {
            let changed = false;
            if (user.role !== "admin") {
              user.role = "admin";
              changed = true;
            }
            if (avatarUrl && user.avatarUrl !== avatarUrl) {
              user.avatarUrl = avatarUrl;
              changed = true;
            }
            if (changed) {
              await user.save();
            }
          }
        } else {
          // Non-admin user must be pre-approved
          if (!user) {
            // Auto-register as pending/inactive user
            user = await User.create({
              email,
              name,
              role: "user",
              isActive: false,
              avatarUrl,
              preferences: {
                preferredContentType: "movie",
                favorites: [],
                recentChannels: []
              }
            });
            // Send SMTP approval email to admin
            sendAdminApprovalRequest(name, email).catch(err => {
              console.error("Failed to send admin approval email:", err);
            });
            return h.response({ error: "Access Denied. Your request for access has been submitted. Please wait for administrator approval." }).code(403);
          }
          if (!user.isActive) {
            return h.response({ error: "Access Denied. Your account is pending administrator approval." }).code(403);
          }
          // If active user, update avatar if changed
          if (avatarUrl && user.avatarUrl !== avatarUrl) {
            user.avatarUrl = avatarUrl;
            await user.save();
          }
        }

        // Generate Access Token (1 hour)
        const accessToken = createJWT({
          userId: user.id,
          email: user.email,
          role: user.role
        }, 3600);

        // Generate Refresh Token (1 month for web, 6 months for TV)
        const refreshExpiry = clientType === "tv" ? 6 * 30 * 24 * 3600 : 30 * 24 * 3600;
        const refreshToken = createJWT({
          userId: user.id,
          type: "refresh",
          clientType
        }, refreshExpiry);

        return {
          accessToken,
          refreshToken,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            avatarUrl: user.avatarUrl
          }
        };
      } catch (error) {
        console.error("Error during Google auth:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/login",
    handler: async (request, h) => {
      try {
        const payload = request.payload as any;
        if (!payload?.email || !payload?.password) {
          return h.response({ error: "Missing email or password" }).code(400);
        }
        const email = payload.email.toLowerCase().trim();
        const password = payload.password;
        const clientType = payload.clientType || "web";

        // Check for Admin credentials configured in .env
        const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
        const adminEmailsList = (process.env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase());
        const isAdminEmail = email === adminEmail || adminEmailsList.includes(email);
        const envAdminPassword = process.env.ADMIN_PASSWORD;

        if (isAdminEmail && envAdminPassword && password === envAdminPassword) {
          let adminUser = await User.findOne({ where: { email } });
          if (!adminUser) {
            adminUser = await User.create({
              email,
              name: "Administrator",
              role: "admin",
              isActive: true,
              preferences: {
                preferredContentType: "movie",
                favorites: [],
                recentChannels: []
              }
            });
          } else if (adminUser.role !== "admin" || !adminUser.isActive) {
            adminUser.role = "admin";
            adminUser.isActive = true;
            await adminUser.save();
          }

          const accessToken = createJWT({
            userId: adminUser.id,
            email: adminUser.email,
            role: adminUser.role
          }, 3600);

          const refreshExpiry = clientType === "tv" ? 6 * 30 * 24 * 3600 : 30 * 24 * 3600;
          const refreshToken = createJWT({
            userId: adminUser.id,
            type: "refresh",
            clientType
          }, refreshExpiry);

          return {
            accessToken,
            refreshToken,
            user: {
              id: adminUser.id,
              email: adminUser.email,
              name: adminUser.name,
              role: adminUser.role,
              avatarUrl: adminUser.avatarUrl
            }
          };
        }

        const user = await User.findOne({ where: { email } });
        if (!user) {
          return h.response({ error: "Invalid email or password" }).code(401);
        }

        if (!user.isActive) {
          return h.response({ error: "Your account is disabled. Please contact the administrator." }).code(403);
        }

        if (!user.passwordHash || !user.salt) {
          return h.response({ error: "Please log in using Google Sign-In" }).code(400);
        }

        const isMatch = verifyPassword(password, user.passwordHash, user.salt);
        if (!isMatch) {
          return h.response({ error: "Invalid email or password" }).code(401);
        }

        // Generate Access Token (1 hour)
        const accessToken = createJWT({
          userId: user.id,
          email: user.email,
          role: user.role
        }, 3600);

        // Generate Refresh Token (1 month for web, 6 months for TV)
        const refreshExpiry = clientType === "tv" ? 6 * 30 * 24 * 3600 : 30 * 24 * 3600;
        const refreshToken = createJWT({
          userId: user.id,
          type: "refresh",
          clientType
        }, refreshExpiry);

        return {
          accessToken,
          refreshToken,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            avatarUrl: user.avatarUrl
          }
        };
      } catch (error) {
        console.error("Error during credentials login:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/signup",
    handler: async (request, h) => {
      try {
        const payload = request.payload as any;
        const email = payload?.email?.toLowerCase().trim();
        const name = payload?.name?.trim();
        const password = payload?.password;

        if (!email || !name || !password) {
          return h.response({ error: "Missing email, name, or password" }).code(400);
        }

        if (password.trim().length < 6) {
          return h.response({ error: "Password must be at least 6 characters" }).code(400);
        }

        const existing = await User.findOne({ where: { email } });
        if (existing) {
          return h.response({ error: "An account with this email already exists." }).code(400);
        }

        const { hash, salt } = hashPassword(password);

        await User.create({
          email,
          name,
          role: "user",
          isActive: false, // Must be approved by admin
          passwordHash: hash,
          salt: salt,
          preferences: {
            preferredContentType: "movie",
            favorites: [],
            recentChannels: []
          }
        });

        // Trigger SMTP approval email to admin in background
        sendAdminApprovalRequest(name, email).catch(err => {
          console.error("Failed to send admin approval email:", err);
        });

        return {
          success: true,
          message: "Signup successful. Your request for access has been submitted. Please wait for administrator approval."
        };
      } catch (error) {
        console.error("Error during credentials signup:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/refresh",
    handler: async (request, h) => {
      try {
        const payload = request.payload as any;
        const refreshToken = payload?.refreshToken;

        if (!refreshToken) {
          return h.response({ error: "Missing refresh token" }).code(400);
        }

        const decoded = verifyJWT(refreshToken);
        if (!decoded || decoded.type !== "refresh") {
          return h.response({ error: "Invalid or expired refresh token" }).code(401);
        }

        const user = await User.findByPk(decoded.userId);
        if (!user || !user.isActive) {
          return h.response({ error: "User is disabled or does not exist" }).code(401);
        }

        // Generate new Access Token (1 hour)
        const accessToken = createJWT({
          userId: user.id,
          email: user.email,
          role: user.role
        }, 3600);

        // Optional: Rotate refresh token if close to expiry, or just reuse it
        return {
          accessToken,
          refreshToken
        };
      } catch (error) {
        console.error("Error during token refresh:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/device/code",
    handler: async (request, h) => {
      try {
        const deviceCode = uuidv4();
        const userCode = generateUserCode();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 mins

        await DeviceCode.create({
          deviceCode,
          userCode: sanitizeCode(userCode),
          status: "pending",
          expiresAt
        });

        // Resolve absolute URL dynamically based on host
        console.log(request);
        
        const host = request.info.host || "localhost:3000";
        const proto = request.headers["x-forwarded-proto"] || "http";
        const verificationUrl = `${proto}://${host}/#/verify?code=${userCode}`;

        return {
          deviceCode,
          userCode,
          verificationUrl,
          expiresIn: 300 // 5 minutes in seconds
        };
      } catch (error) {
        console.error("Error generating device code:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/device/poll",
    handler: async (request, h) => {
      try {
        const payload = request.payload as any;
        const deviceCode = payload?.deviceCode;

        if (!deviceCode) {
          return h.response({ error: "Missing deviceCode" }).code(400);
        }

        const record = await DeviceCode.findByPk(deviceCode);

        if (!record) {
          return h.response({ status: "expired" }).code(200);
        }

        if (new Date() > record.expiresAt) {
          record.status = "expired";
          await record.save();
          return { status: "expired" };
        }

        if (record.status === "pending") {
          return { status: "pending" };
        }

        if (record.status === "authorized" && record.userId) {
          const user = await User.findByPk(record.userId);
          if (!user || !user.isActive) {
            return h.response({ error: "Authorized user is inactive or deleted" }).code(403);
          }

          // Issue TV Tokens (6 months refresh)
          const accessToken = createJWT({
            userId: user.id,
            email: user.email,
            role: user.role
          }, 3600);

          const refreshToken = createJWT({
            userId: user.id,
            type: "refresh",
            clientType: "tv"
          }, 6 * 30 * 24 * 3600);

          // Clean up the device code from database
          await record.destroy();

          return {
            status: "authorized",
            accessToken,
            refreshToken,
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              role: user.role,
              avatarUrl: user.avatarUrl
            }
          };
        }

        return { status: record.status };
      } catch (error) {
        console.error("Error polling device code:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/device/authorize",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const payload = request.payload as any;
        const userCodeInput = payload?.userCode;

        if (!userCodeInput) {
          return h.response({ error: "Missing user code" }).code(400);
        }

        const sanitized = sanitizeCode(userCodeInput);

        const record = await DeviceCode.findOne({
          where: {
            userCode: sanitized,
            status: "pending"
          }
        });

        if (!record || new Date() > record.expiresAt) {
          return h.response({ error: "Invalid or expired user authorization code" }).code(400);
        }

        // Authorize this device code for the authenticated user
        record.userId = userPayload.userId;
        record.status = "authorized";
        await record.save();

        return { success: true, message: "Device successfully authorized!" };
      } catch (error) {
        console.error("Error authorizing device code:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
];
