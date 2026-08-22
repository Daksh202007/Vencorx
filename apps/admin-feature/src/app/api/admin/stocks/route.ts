import { NextResponse } from 'next/server';

const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || 'http://localhost:3001';

/**
   * POST: Add a new stock.
   * Tells chat-service to fetch 2000 days of history and subscribe the stock in the live connections pool.
   */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { symbol, exchange } = body;

    if (!symbol || !exchange) {
      return NextResponse.json({ success: false, error: 'Parameters "symbol" and "exchange" (NSE/BSE) are required' }, { status: 400 });
    }

    const response = await fetch(`${CHAT_SERVICE_URL}/api/market-data/stocks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ symbol, exchange }),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: 'Failed to contact chat-service for stock addition', details: err.message }, { status: 500 });
  }
}

/**
 * DELETE: Remove a stock from active websocket streaming.
 * Tells chat-service to unsubscribe the stock from active connection pool. All historical tick data is preserved.
 */
export async function DELETE(req: Request) {
  try {
    const body = await req.json();
    const { symbol } = body;

    if (!symbol) {
      return NextResponse.json({ success: false, error: 'Parameter "symbol" is required' }, { status: 400 });
    }

    const response = await fetch(`${CHAT_SERVICE_URL}/api/market-data/stocks`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ symbol }),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: 'Failed to contact chat-service for stock deletion', details: err.message }, { status: 500 });
  }
}
