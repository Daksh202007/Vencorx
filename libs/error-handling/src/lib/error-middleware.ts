import { AppError } from './index';
import { NextResponse } from 'next/server';

// Adapted for Next.js App Router API Routes
export const handleApiError = (err: Error) => {
  if (err instanceof AppError) {
    console.error(`AppError: ${err.message}`);

    return NextResponse.json(
      {
        status: "error",
        message: err.message,
        ...(err.details && { details: err.details }),
      },
      { status: err.statusCode }
    );
  }

  console.error("Unhandled error", err);

  return NextResponse.json(
    {
      error: "Something went wrong, please try again later",
    },
    { status: 500 }
  );
};

// Wrapper for Next.js route handlers
export const withErrorHandling = (handler: Function) => {
  return async (req: Request, ...args: any[]) => {
    try {
      return await handler(req, ...args);
    } catch (error: any) {
      return handleApiError(error);
    }
  };
};
