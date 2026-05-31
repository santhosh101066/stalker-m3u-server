import { ServerRoute } from "@hapi/hapi";
import { User } from "../models/User";
import { authCheck } from "../utils/jwt";
import { hashPassword } from "../utils/password";
import { sendUserApprovedEmail } from "@/utils/email";

export const userManagementRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/admin/users",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload || userPayload.role !== "admin") {
        return h.response({ error: "Forbidden" }).code(403);
      }

      try {
        const users = await User.findAll({
          order: [["createdAt", "DESC"]]
        });
        return users;
      } catch (error) {
        console.error("Error listing users:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/admin/users",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload || userPayload.role !== "admin") {
        return h.response({ error: "Forbidden" }).code(403);
      }

      try {
        const payload = request.payload as any;
        const { email, name, role, isActive, password } = payload;

        if (!email || !name) {
          return h.response({ error: "Email and Name are required" }).code(400);
        }

        const normalizedEmail = email.toLowerCase().trim();

        const existing = await User.findOne({ where: { email: normalizedEmail } });
        if (existing) {
          return h.response({ error: "User with this email already exists" }).code(400);
        }

        let passwordFields = {};
        if (password && password.trim().length >= 6) {
          const { hash, salt } = hashPassword(password);
          passwordFields = { passwordHash: hash, salt };
        } else if (password) {
          return h.response({ error: "Password must be at least 6 characters" }).code(400);
        }

        const newUser = await User.create({
          email: normalizedEmail,
          name: name.trim(),
          role: role || "user",
          isActive: isActive !== undefined ? !!isActive : true,
          preferences: {
            preferredContentType: "movie",
            favorites: [],
            recentChannels: []
          },
          ...passwordFields
        });

        // Don't return credentials fields in response
        const resUser = newUser.toJSON() as any;
        delete resUser.passwordHash;
        delete resUser.salt;
        return resUser;
      } catch (error) {
        console.error("Error creating user:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "PUT",
    path: "/api/admin/users/{id}",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload || userPayload.role !== "admin") {
        return h.response({ error: "Forbidden" }).code(403);
      }

      try {
        const id = request.params.id;
        const payload = request.payload as any;
        const { name, role, isActive, password } = payload;

        const user = await User.findByPk(id);
        if (!user) {
          return h.response({ error: "User not found" }).code(404);
        }

        if (Number(user.id) === Number(userPayload.userId)) {
          if (isActive === false) {
            return h.response({ error: "You cannot disable your own account" }).code(400);
          }
          if (role && role !== "admin") {
            return h.response({ error: "You cannot change your own admin role" }).code(400);
          }
        }

        // Check if the user is being newly approved
        const wasInactive = !user.isActive;
        const isBeingActivated = isActive === true;
        const isNewlyApproved = wasInactive && isBeingActivated;

        if (name !== undefined) user.name = name.trim();
        if (role !== undefined) user.role = role;
        if (isActive !== undefined) user.isActive = !!isActive;

        if (password) {
          if (password.trim().length < 6) {
            return h.response({ error: "Password must be at least 6 characters" }).code(400);
          }
          const { hash, salt } = hashPassword(password);
          user.passwordHash = hash;
          user.salt = salt;
        }

        await user.save();

        // Trigger the approval email if the status changed from inactive to active
        if (isNewlyApproved) {
          sendUserApprovedEmail(user.name, user.email).catch(err => {
            console.error("Failed to send user approval email after admin update:", err);
          });
        }

        const resUser = user.toJSON() as any;
        delete resUser.passwordHash;
        delete resUser.salt;
        return resUser;
      } catch (error) {
        console.error("Error updating user:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/admin/users/{id}",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload || userPayload.role !== "admin") {
        return h.response({ error: "Forbidden" }).code(403);
      }

      try {
        const id = request.params.id;

        const user = await User.findByPk(id);
        if (!user) {
          return h.response({ error: "User not found" }).code(404);
        }

        // Prevent admin from deleting themselves
        if (Number(user.id) === Number(userPayload.userId)) {
          return h.response({ error: "You cannot delete your own account" }).code(400);
        }

        await user.destroy();
        return { success: true, message: "User deleted successfully" };
      } catch (error) {
        console.error("Error deleting user:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
];
