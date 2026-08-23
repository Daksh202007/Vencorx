import { NextResponse } from 'next/server';
import { withErrorHandling } from '@errorHandling-middleware';
import { AppError } from '@errHandling-index';
import { signToken, verifyToken } from '../../../../../lib/jwt';

const newAccessTokenHandler = async (req: Request) => {
  const body = await req.json();
  const { refreshToken } = body;

  if (!refreshToken) {
    throw new AppError('Refresh token is required', 400);
  }

  const decoded = verifyToken(refreshToken);

  // Enforce Admin Role
  if (decoded.role !== 'ADMIN' && decoded.role !== 'SUPER_ADMIN') {
    throw new AppError('Invalid token role for admin refresh', 403);
  }

  const newAccessToken = signToken({ id: decoded.id, role: decoded.role }, '15m');
  const newRefreshToken = signToken({ id: decoded.id, role: decoded.role }, '7d');

  return NextResponse.json({
    success: true,
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  });
};

export const POST = withErrorHandling(newAccessTokenHandler);
