import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/prisma';
import { withErrorHandling } from '@errorHandling-middleware';
import { AppError } from '@errHandling-index';
import { verifyToken } from '../../../../../lib/jwt';

const verifyAdminRegistrationHandler = async (req: Request) => {
  const body = await req.json();
  const { adminEmailToApprove } = body;

  // Expecting a JWT token from the headers to verify it's a super admin
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError('Unauthorized', 401);
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = verifyToken(token);
  } catch (err) {
    throw new AppError('Invalid token', 401);
  }

  if (decoded.role !== 'SUPER_ADMIN' && decoded.role !== 'ADMIN') { // assuming some admins can approve
    throw new AppError('Forbidden: only admins can approve new admins', 403);
  }

  const adminToApprove = await prisma.admin.findUnique({
    where: { email: adminEmailToApprove },
  });

  if (!adminToApprove) {
    throw new AppError('Admin not found', 404);
  }

  await prisma.admin.update({
    where: { email: adminEmailToApprove },
    data: { isApproved: true, isVerified: true },
  });

  return NextResponse.json({
    success: true,
    message: `Admin ${adminEmailToApprove} has been approved.`,
  });
};

export const POST = withErrorHandling(verifyAdminRegistrationHandler);
