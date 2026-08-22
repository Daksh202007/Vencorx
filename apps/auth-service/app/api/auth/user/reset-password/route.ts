import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import bcrypt from 'bcrypt';
import { withErrorHandling } from '@errorHandling-middleware';
import { AppError } from '@errHandling-index';
import { verifyToken } from '../../../../../lib/jwt';

const resetPasswordHandler = async (req: Request) => {
  const body = await req.json();
  const { resetToken, newPassword } = body;

  if (!resetToken || !newPassword) {
    throw new AppError('Reset token and new password are required', 400);
  }

  if (newPassword.length < 6) {
    throw new AppError('Password must be at least 6 characters long', 400);
  }

  let decoded;
  try {
    decoded = verifyToken(resetToken);
  } catch (err) {
    throw new AppError('Invalid or expired reset token', 401);
  }

  if (decoded.purpose !== 'reset-password') {
    throw new AppError('Invalid token purpose', 401);
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { id: decoded.id },
    data: { password: hashedPassword },
  });

  return NextResponse.json({
    success: true,
    message: 'Password reset successfully',
  });
};

export const POST = withErrorHandling(resetPasswordHandler);
