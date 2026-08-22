import { redis } from './redis';
import { AppError } from '@errHandling-index';
import { sendMail } from './sendMail';

export const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const validateRegistrationData = (data: any) => {
  const { name, email, password } = data;

  if (!name || !email || !password) {
    throw new AppError('Name, email, and password are required', 400);
  }

  if (!emailRegex.test(email)) {
    throw new AppError('Invalid email format', 400);
  }

  if (password.length < 6) {
    throw new AppError('Password must be at least 6 characters long', 400);
  }
};

export const checkOtpRestriction = async (email: string) => {
  const isLocked = await redis.get(`otp_lock:${email}`);
  if (isLocked) {
    throw new AppError('Account locked due to multiple failed attempts! Try again after 30 minutes', 429);
  }

  const isSpamLocked = await redis.get(`otp_spam_lock:${email}`);
  if (isSpamLocked) {
    throw new AppError('Too many OTP requests! Please wait 1 hour before request again.', 429);
  }

  const isCooldown = await redis.get(`otp_cooldown:${email}`);
  if (isCooldown) {
    throw new AppError('Please wait 1 minute before requesting a new OTP!', 429);
  }
};

export const trackOtpRequests = async (email: string) => {
  const requestCountKey = `otp_request_count:${email}`;
  const requestCount = await redis.get(requestCountKey);

  if (requestCount && parseInt(requestCount as string) >= 5) {
    await redis.setex(`otp_spam_lock:${email}`, 3600, 'true'); // 1 hour lock
    await redis.del(requestCountKey);
    throw new AppError('Too many OTP requests! Please wait 1 hour before request again.', 429);
  }

  if (!requestCount) {
    await redis.setex(requestCountKey, 3600, 1); // expire in 1 hour
  } else {
    await redis.incr(requestCountKey);
  }
};

export const sendOtp = async (email: string, name: string) => {
  const otp = Math.floor(1000 + Math.random() * 9000).toString();

  await redis.setex(`otp:${email}`, 300, otp); // 5 minutes
  await redis.setex(`otp_cooldown:${email}`, 60, 'true'); // 1 minute cooldown

  await sendMail({
    email,
    subject: 'Your Account Activation Code',
    template: 'user-activation-mail.ejs',
    data: { user: { name }, activationCode: otp },
  });
};

export const verifyOtp = async (email: string, otp: string) => {
  const storedOtp = await redis.get(`otp:${email}`);

  if (!storedOtp || storedOtp !== otp) {
    const failedAttemptsKey = `failed_attempts:${email}`;
    const failedAttempts = await redis.incr(failedAttemptsKey);

    if (failedAttempts === 1) {
      await redis.expire(failedAttemptsKey, 60); // 1 minute expiry for failed attempts
    }

    if (failedAttempts >= 3) {
      await redis.setex(`otp_lock:${email}`, 1800, 'true'); // 30 minutes lock
      await redis.del(failedAttemptsKey);
      throw new AppError('Account locked due to multiple failed attempts! Try again after 30 minutes', 429);
    }

    throw new AppError('Invalid or expired OTP', 400);
  }

  await redis.del(`otp:${email}`);
  await redis.del(`failed_attempts:${email}`);
};
