import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as jose from 'jose';

// Middleware for stateless JWT authentication for Admins using jose (Edge compatible)
export async function middleware(request: NextRequest) {
  // Only protect /api/admin/* routes
  if (request.nextUrl.pathname.startsWith('/api/admin/')) {
    const authHeader = request.headers.get('authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ success: false, error: 'Unauthorized: Missing or invalid Authorization header' }, { status: 401 });
    }

    const token = authHeader.split(' ')[1];
    const publicKeyEnv = process.env.JWT_PUBLIC_KEY;

    if (!publicKeyEnv) {
      console.error('JWT_PUBLIC_KEY is not defined in environment');
      return NextResponse.json({ success: false, error: 'Internal Server Error: Missing JWT_PUBLIC_KEY' }, { status: 500 });
    }

    try {
      // Parse the public key for jose
      const publicKey = await jose.importSPKI(publicKeyEnv.replace(/\\n/g, '\n'), 'RS256');
      
      // Verify token signature statelessly
      const { payload } = await jose.jwtVerify(token, publicKey);
      
      // Strict authorization check: Only allow ADMIN or SUPER_ADMIN
      if (payload.role !== 'ADMIN' && payload.role !== 'SUPER_ADMIN') {
        return NextResponse.json({ success: false, error: 'Forbidden: You do not have admin privileges' }, { status: 403 });
      }

      // Clone the request headers and inject the verified admin payload
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set('x-admin-id', payload.id as string);
      requestHeaders.set('x-admin-email', payload.email as string);
      requestHeaders.set('x-admin-role', payload.role as string);

      return NextResponse.next({
        request: {
          headers: requestHeaders,
        },
      });
    } catch (err) {
      return NextResponse.json({ success: false, error: 'Unauthorized: Invalid or expired token' }, { status: 401 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/admin/:path*',
};
