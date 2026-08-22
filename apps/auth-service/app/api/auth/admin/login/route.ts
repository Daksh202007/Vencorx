import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import bcrypt from 'bcrypt';
import { withErrorHandling } from '@errorHandling-middleware';
import { AppError } from '@errHandling-index';
import { checkOtpRestriction, trackOtpRequests, sendOtp } from '../../../../../lib/auth.helper';

const adminLoginHandler = async (req: Request) => {
  const body = await req.json();
  const { email, password } = body;

  if (!email || !password) {
    throw new AppError('Email and password are required', 400);
  }

  const admin = await prisma.admin.findUnique({
    where: { email },
  });

  if (!admin) {
    throw new AppError('Invalid email or password', 400);
  }

  if (!admin.isApproved) {
    throw new AppError('Admin account not yet approved', 403);
  }

  const isPasswordValid = await bcrypt.compare(password, admin.password);

  if (!isPasswordValid) {
    throw new AppError('Invalid email or password', 400);
  }

  // Generate and send OTP for 2FA login
  await checkOtpRestriction(email);
  await trackOtpRequests(email);
  await sendOtp(email, admin.name);

  return NextResponse.json({
    success: true,
    message: 'OTP sent for login verification',
  });
};

export const POST = withErrorHandling(adminLoginHandler);
