import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET(req: Request) {
  try {
    // Read the securely injected headers from middleware
    const userId = req.headers.get('x-user-id');

    if (!userId) {
      return NextResponse.json({ success: false, error: 'Missing User ID in headers' }, { status: 400 });
    }

    // Fetch user from DB
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isVerified: true,
        watchlist: true,
        createdAt: true,
      },
    });

    if (!user) {
      return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, user });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: 'Failed to fetch user profile', details: err.message }, { status: 500 });
  }
}
