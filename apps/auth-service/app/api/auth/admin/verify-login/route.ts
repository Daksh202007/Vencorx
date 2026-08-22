import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { withErrorHandling } from '@errorHandling-middleware';
import { AppError } from '@errHandling-index';
import { verifyOtp } from '../../../../../lib/auth.helper';
import { signToken } from '../../../../../lib/jwt';

const verifyAdminLoginHandler = async (req: Request) => {
  const body = await req.json();
  const { email, otp } = body;

  if (!email || !otp) {
    throw new AppError('Email and OTP are required', 400);
  }

  const admin = await prisma.admin.findUnique({
    where: { email },
  });

  if (!admin || !admin.isApproved) {
    throw new AppError('Admin not found or not approved', 400);
  }

  await verifyOtp(email, otp);

  const accessToken = signToken({ id: admin.id, role: admin.role }, '15m');
  const refreshToken = signToken({ id: admin.id, role: admin.role }, '7d');

  return NextResponse.json({
    success: true,
    message: 'Admin login successful',
    accessToken,
    refreshToken,
  });
};

export const POST = withErrorHandling(verifyAdminLoginHandler);
