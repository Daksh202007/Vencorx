import { NextResponse } from 'next/server';
import { withErrorHandling } from '@errorHandling-middleware';
import { AppError } from '@errHandling-index';
import { verifyOtp } from '../../../../../lib/auth.helper';
import { signToken } from '../../../../../lib/jwt';
import { prisma } from '../../../../../lib/prisma';

const adminVerifyForgotPasswordHandler = async (req: Request) => {
  const body = await req.json();
  const { email, otp } = body;

  if (!email || !otp) {
    throw new AppError('Email and OTP are required', 400);
  }

  const admin = await prisma.admin.findUnique({
    where: { email },
  });

  if (!admin || !admin.isApproved) {
    throw new AppError('Admin not found or not approved', 404);
  }

  await verifyOtp(email, otp);

  const resetToken = signToken({ id: admin.id, email: admin.email, role: admin.role, purpose: 'reset-password' }, '15m');

  return NextResponse.json({
    success: true,
    message: 'OTP verified successfully',
    resetToken,
  });
};

export const POST = withErrorHandling(adminVerifyForgotPasswordHandler);
