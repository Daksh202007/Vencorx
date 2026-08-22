import { NextResponse } from 'next/server';
import { Client } from 'pg';

/**
 * POST: Clear all database history for a specific stock symbol.
 * This is an explicit administrative destructive action that purges time-series data.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { symbol } = body;

    if (!symbol) {
      return NextResponse.json({ success: false, error: 'Parameter "symbol" is required' }, { status: 400 });
    }

    const connectionString = process.env.TIMESCALE_URL || process.env.DATABASE_URL;
    if (!connectionString || (!connectionString.startsWith('postgres://') && !connectionString.startsWith('postgresql://'))) {
      return NextResponse.json({ 
        success: false, 
        error: 'Invalid database configuration. TIMESCALE_URL or DATABASE_URL must point to a PostgreSQL/TimescaleDB instance.' 
      }, { status: 500 });
    }

    const client = new Client({ connectionString });
    await client.connect();

    // Delete all ticks/candles associated with the symbol
    const result = await client.query('DELETE FROM stock_ticks WHERE stock = $1', [symbol]);
    
    await client.end();

    return NextResponse.json({
      success: true,
      message: `Successfully purged all historical tick logs for stock "${symbol}" from TimescaleDB. Rows affected: ${result.rowCount || 0}`,
    });
  } catch (err: any) {
    return NextResponse.json({ 
      success: false, 
      error: 'Failed to execute history clear operation', 
      details: err.message 
    }, { status: 500 });
  }
}
