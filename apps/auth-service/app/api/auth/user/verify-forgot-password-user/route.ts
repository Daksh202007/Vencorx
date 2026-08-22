import { NextResponse } from 'next/server';
import { withErrorHandling } from '@errorHandling-middleware';
import { AppError } from '@errHandling-index';
import { verifyOtp } from '../../../../../lib/auth.helper';
import { signToken } from '../../../../../lib/jwt';
import { prisma } from '../../../../../lib/prisma';

const verifyForgotPasswordHandler = async (req: Request) => {
  const body = await req.json();
  const { email, otp } = body;

  if (!email || !otp) {
    throw new AppError('Email and OTP are required', 400);
  }

  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    throw new AppError('User not found', 404);
  }

  await verifyOtp(email, otp);

  // Generate a short-lived token to be used exclusively for resetting the password
  const resetToken = signToken({ id: user.id, email: user.email, purpose: 'reset-password' }, '15m');

  return NextResponse.json({
    success: true,
    message: 'OTP verified successfully',
    resetToken,
  });
};

export const POST = withErrorHandling(verifyForgotPasswordHandler);
