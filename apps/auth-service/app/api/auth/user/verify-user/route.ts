import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { withErrorHandling } from '@errorHandling-middleware';
import { AppError } from '@errHandling-index';
import { verifyOtp } from '../../../../../lib/auth.helper';
import { signToken } from '../../../../../lib/jwt';

const verifyUserHandler = async (req: Request) => {
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

  await prisma.user.update({
    where: { email },
    data: { isVerified: true },
  });

  const accessToken = signToken({ id: user.id, role: user.role }, '15m');
  const refreshToken = signToken({ id: user.id, role: user.role }, '7d');

  return NextResponse.json({
    success: true,
    message: 'Verification successful',
    accessToken,
    refreshToken,
  });
};

export const POST = withErrorHandling(verifyUserHandler);
