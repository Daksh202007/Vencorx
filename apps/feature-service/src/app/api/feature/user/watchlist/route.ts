import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// GET user's watchlist
export async function GET(req: Request) {
  try {
    const userId = req.headers.get('x-user-id');
    if (!userId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { watchlist: true },
    });

    if (!user) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 });

    return NextResponse.json({ success: true, watchlist: user.watchlist });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: 'Failed to fetch watchlist' }, { status: 500 });
  }
}

// POST a new stock to watchlist
export async function POST(req: Request) {
  try {
    const userId = req.headers.get('x-user-id');
    if (!userId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { symbol } = body;
    if (!symbol) return NextResponse.json({ success: false, error: 'Symbol is required' }, { status: 400 });

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        watchlist: { push: symbol },
      },
      select: { watchlist: true },
    });

    // Remove duplicates manually (MongoDB doesn't have a distinct push)
    const uniqueWatchlist = Array.from(new Set(user.watchlist));
    if (uniqueWatchlist.length !== user.watchlist.length) {
      await prisma.user.update({
        where: { id: userId },
        data: { watchlist: uniqueWatchlist },
      });
    }

    return NextResponse.json({ success: true, watchlist: uniqueWatchlist });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: 'Failed to add to watchlist' }, { status: 500 });
  }
}

// DELETE a stock from watchlist
export async function DELETE(req: Request) {
  try {
    const userId = req.headers.get('x-user-id');
    if (!userId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { symbol } = body;
    if (!symbol) return NextResponse.json({ success: false, error: 'Symbol is required' }, { status: 400 });

    // Fetch current watchlist
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { watchlist: true } });
    if (!user) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 });

    const updatedWatchlist = user.watchlist.filter(s => s !== symbol);

    await prisma.user.update({
      where: { id: userId },
      data: { watchlist: updatedWatchlist },
    });

    return NextResponse.json({ success: true, watchlist: updatedWatchlist });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: 'Failed to remove from watchlist' }, { status: 500 });
  }
}
