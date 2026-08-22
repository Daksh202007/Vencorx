import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import bcrypt from 'bcrypt';
import { withErrorHandling } from '@errorHandling-middleware';
import { AppError } from '@errHandling-index';
import {
  validateRegistrationData,
  checkOtpRestriction,
  trackOtpRequests,
  sendOtp,
} from '../../../../../lib/auth.helper';

const registrationHandler = async (req: Request) => {
  const body = await req.json();
  const { name, email, password } = body;

  validateRegistrationData(body);

  const existingUser = await prisma.user.findUnique({
    where: { email },
  });

  if (existingUser) {
    if (existingUser.isVerified) {
      throw new AppError('User already exists', 400);
    }
    // If not verified, allow them to register again (resend OTP basically)
  }

  await checkOtpRestriction(email);
  await trackOtpRequests(email);

  const hashedPassword = await bcrypt.hash(password, 10);

  if (!existingUser) {
    await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
      },
    });
  } else {
    await prisma.user.update({
      where: { email },
      data: { name, password: hashedPassword },
    });
  }

  await sendOtp(email, name);

  return NextResponse.json({
    success: true,
    message: `OTP sent to ${email}`,
  });
};

export const POST = withErrorHandling(registrationHandler);
