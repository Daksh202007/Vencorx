import fs from 'fs';
import nodemailer from 'nodemailer';
import ejs from 'ejs';
import path from 'path';
import { AppError } from '@errHandling-index';

interface EmailOptions {
  email: string;
  subject: string;
  template: string;
  data: { [key: string]: any };
}

export const sendMail = async (options: EmailOptions): Promise<void> => {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    service: process.env.SMTP_SERVICE,
    auth: {
      user: process.env.SMTP_MAIL,
      pass: process.env.SMTP_PASSWORD,
    },
  });

  const { email, subject, template, data } = options;
  
  // Resolve path dynamically depending on process.cwd() (workspace root or project root)
  let templatePath = path.join(process.cwd(), 'lib/email-templates', template);
  if (!fs.existsSync(templatePath)) {
    templatePath = path.join(process.cwd(), 'apps/auth-service/lib/email-templates', template);
  }

  try {
    const html = await ejs.renderFile(templatePath, data);

    const mailOptions = {
      from: process.env.SMTP_MAIL,
      to: email,
      subject,
      html,
    };

    await transporter.sendMail(mailOptions);
  } catch (error: any) {
    throw new AppError(`Email could not be sent: ${error.message}`, 500);
  }
};
