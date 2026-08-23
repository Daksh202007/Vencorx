import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as jose from 'jose';

// Middleware for stateless JWT authentication using jose (Edge compatible)
export async function middleware(request: NextRequest) {
  // Only protect /api/feature/* routes
  if (request.nextUrl.pathname.startsWith('/api/feature/')) {
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
      
      // Clone the request headers and inject the verified user payload
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set('x-user-id', payload.id as string);
      requestHeaders.set('x-user-email', payload.email as string);
      if (payload.role) requestHeaders.set('x-user-role', payload.role as string);

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
  matcher: '/api/feature/:path*',
};
