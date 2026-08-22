import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import bcrypt from 'bcrypt';
import { withErrorHandling } from '@errorHandling-middleware';
import { AppError } from '@errHandling-index';
import { signToken } from '../../../../../lib/jwt';

const loginHandler = async (req: Request) => {
  const body = await req.json();
  const { email, password } = body;

  if (!email || !password) {
    throw new AppError('Email and password are required', 400);
  }

  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user || !user.isVerified) {
    throw new AppError('Invalid email or password, or user not verified', 400);
  }

  const isPasswordValid = await bcrypt.compare(password, user.password);

  if (!isPasswordValid) {
    throw new AppError('Invalid email or password', 400);
  }

  const accessToken = signToken({ id: user.id, role: user.role }, '15m');
  const refreshToken = signToken({ id: user.id, role: user.role }, '7d');

  return NextResponse.json({
    success: true,
    message: 'Login successful',
    accessToken,
    refreshToken,
  });
};

export const POST = withErrorHandling(loginHandler);
