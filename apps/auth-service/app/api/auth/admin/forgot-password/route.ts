import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { withErrorHandling } from '@errorHandling-middleware';
import { AppError } from '@errHandling-index';
import { checkOtpRestriction, trackOtpRequests, sendOtp } from '../../../../../lib/auth.helper';

const adminForgotPasswordHandler = async (req: Request) => {
  const body = await req.json();
  const { email } = body;

  if (!email) {
    throw new AppError('Email is required', 400);
  }

  const admin = await prisma.admin.findUnique({
    where: { email },
  });

  if (!admin || !admin.isApproved) {
    throw new AppError('Admin not found or not approved', 404);
  }

  await checkOtpRestriction(email);
  await trackOtpRequests(email);
  await sendOtp(email, admin.name);

  return NextResponse.json({
    success: true,
    message: `Password reset OTP sent to ${email}`,
  });
};

export const POST = withErrorHandling(adminForgotPasswordHandler);
