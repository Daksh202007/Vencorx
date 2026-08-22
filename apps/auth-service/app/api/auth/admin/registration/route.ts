import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import bcrypt from 'bcrypt';
import { withErrorHandling } from '@errorHandling-middleware';
import { AppError } from '@errHandling-index';
import { emailRegex } from '../../../../../lib/auth.helper';

const adminRegistrationHandler = async (req: Request) => {
  const body = await req.json();
  const { name, email, password } = body;

  if (!name || !email || !password) {
    throw new AppError('Name, email, and password are required', 400);
  }

  if (!emailRegex.test(email)) {
    throw new AppError('Invalid email format', 400);
  }

  if (password.length < 12) {
    throw new AppError('Admin password must be at least 12 characters long', 400);
  }

  const existingAdmin = await prisma.admin.findUnique({
    where: { email },
  });

  if (existingAdmin) {
    throw new AppError('Admin already exists', 400);
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  await prisma.admin.create({
    data: {
      name,
      email,
      password: hashedPassword,
    },
  });

  return NextResponse.json({
    success: true,
    message: 'Admin registered successfully. Waiting for approval.',
  });
};

export const POST = withErrorHandling(adminRegistrationHandler);
