import jwt from 'jsonwebtoken';
import { AppError } from '@errHandling-index';

// Fetch RSA keys from environment variables
const getPrivateKey = () => {
  const key = process.env.JWT_PRIVATE_KEY;
  if (!key) throw new AppError('JWT_PRIVATE_KEY is not defined', 500);
  // Ensure the key is properly formatted with newlines if it's passed as a single string
  return key.replace(/\\n/g, '\n');
};

const getPublicKey = () => {
  const key = process.env.JWT_PUBLIC_KEY;
  if (!key) throw new AppError('JWT_PUBLIC_KEY is not defined', 500);
  return key.replace(/\\n/g, '\n');
};

export const signToken = (payload: object, expiresIn: string | number = '1d'): string => {
  try {
    return jwt.sign(payload, getPrivateKey(), {
      algorithm: 'RS256',
      expiresIn: expiresIn as any,
    });
  } catch (error: any) {
    throw new AppError(`Error signing token: ${error.message}`, 500);
  }
};

export const verifyToken = (token: string): any => {
  try {
    return jwt.verify(token, getPublicKey(), {
      algorithms: ['RS256'],
    });
  } catch (error: any) {
    throw new AppError('Invalid or expired token', 401);
  }
};
