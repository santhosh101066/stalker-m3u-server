import nodemailer from "nodemailer";

/**
 * Sends an email notification to the ADMIN_EMAIL when a new user registers and is pending approval.
 */
export async function sendAdminApprovalRequest(name: string, email: string): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn("SMTP Warning: ADMIN_EMAIL is not configured. Approval email skipped.");
    return;
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || `"Stalker Portal" <${user}>`;

  if (!host || !user || !pass) {
    console.warn("SMTP Warning: Mail server host/user/pass is not configured. Approval email skipped.");
    return;
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for other ports
    auth: {
      user,
      pass,
    },
  });

  const mailOptions = {
    from,
    to: adminEmail,
    subject: `Approval Request: New User - ${name}`,
    text: `A new user has registered and is pending approval:\n\nName: ${name}\nEmail: ${email}\n\nPlease sign in to the Admin Panel and activate their profile.`,
    html: `<div style="font-family: sans-serif; padding: 20px; color: #333; max-width: 500px; border: 1px solid #e2e8f0; border-radius: 12px;">
      <h2 style="color: #4f46e5; margin-top: 0;">Access Request Pending</h2>
      <p>A new user has signed up and is waiting for your authorization:</p>
      <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; margin: 16px 0;">
        <p style="margin: 0 0 8px 0;"><strong>Name:</strong> ${name}</p>
        <p style="margin: 0;"><strong>Email:</strong> ${email}</p>
      </div>
      <p style="font-size: 14px; color: #64748b; line-height: 1.5;">
        Please log in to the portal as an administrator, go to <strong>Admin Panel -> Users</strong>, and toggle their status to <strong>Active</strong> to approve their access.
      </p>
    </div>`,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Approval request email sent to admin: ${adminEmail}`);
  } catch (error) {
    console.error("Failed to send SMTP approval notification:", error);
  }
}

export async function sendUserApprovedEmail(name: string, email: string): Promise<void> {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || `"Stalker Portal" <${user}>`;

  if (!host || !user || !pass) {
    console.warn("SMTP Warning: Mail server host/user/pass is not configured. User approval email skipped.");
    return;
  }

  // Assuming nodemailer is already imported at the top of your file
  // import nodemailer from "nodemailer";
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for other ports
    auth: {
      user,
      pass,
    },
  });

  const mailOptions = {
    from,
    to: email,
    subject: `Stalker VOD - Your Account is Approved!`,
    text: `Hello ${name},\n\nGreat news! Your account request for the Stalker VOD Portal has been approved by the administrator.\n\nYou can now log in using your email or Google Sign-In to access the platform.\n\nEnjoy streaming!\n- Stalker Team`,
    html: `<div style="font-family: sans-serif; padding: 20px; color: #333; max-width: 500px; border: 1px solid #e2e8f0; border-radius: 12px;">
      <h2 style="color: #10b981; margin-top: 0;">Account Approved!</h2>
      <p>Hello ${name},</p>
      <p>Great news! Your account request for the <strong>Stalker VOD Portal</strong> has been officially approved by the administrator.</p>
      <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; margin: 16px 0;">
        <p style="margin: 0; color: #334155;">
          You can now log in using your registered email credentials or via Google Sign-In to access the platform.
        </p>
      </div>
      <p style="font-size: 14px; color: #64748b; line-height: 1.5;">
        Get ready to explore the new visual theme and advanced playback engine. Your ultimate streaming experience starts here!
      </p>
      <p style="margin-top: 24px; font-size: 14px; font-weight: bold; color: #333;">
        Enjoy streaming,<br/>Stalker Team
      </p>
    </div>`,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Approval email successfully sent to user: ${email}`);
  } catch (error) {
    console.error("Failed to send SMTP user approval email:", error);
  }
}
