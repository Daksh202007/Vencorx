import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { withErrorHandling } from '@errorHandling-middleware';
import { AppError } from '@errHandling-index';
import { checkOtpRestriction, trackOtpRequests, sendOtp } from '../../../../../lib/auth.helper';

const forgotPasswordHandler = async (req: Request) => {
  const body = await req.json();
  const { email } = body;

  if (!email) {
    throw new AppError('Email is required', 400);
  }

  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    throw new AppError('User not found', 404);
  }

  await checkOtpRestriction(email);
  await trackOtpRequests(email);

  await sendOtp(email, user.name);

  return NextResponse.json({
    success: true,
    message: `Password reset OTP sent to ${email}`,
  });
};

export const POST = withErrorHandling(forgotPasswordHandler);
